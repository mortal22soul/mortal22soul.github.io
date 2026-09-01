---
title: "The 89.68% Accurate Deepfake Detector That Learned Almost Nothing"
description: "What a collapsed ResNet experiment revealed about accuracy, EER, attack-level evaluation, score fusion, and reproducibility in audio deepfake detection."
date: "Mar 12 2026"
draft: false
---

# The 89.68% accurate deepfake detector that learned almost nothing

An early ResNet-18 experiment in this project reached 89.68% accuracy on the ASVspoof 2019 evaluation set. It also had a 47.57% equal error rate and classified every bonafide recording incorrectly.

That is not a typo. About 89.7% of the evaluation samples are spoofed, so a model can get close to 90% accuracy by calling everything fake. The result looked healthy until the per-attack table exposed it.

This failure changed how I read every later experiment. A single aggregate number is not enough for audio deepfake detection. The model must separate real speech from attacks it did not see during training, its threshold must fit the scores it produces, and its mistakes need to be inspected attack by attack.

This project grew into a full PyTorch pipeline for doing that work. It parses ASVspoof protocols, caches two acoustic representations, trains five current model classes through six profiles, computes global and attack-level metrics, fuses models, produces attribution maps, and serves predictions through Gradio. The trail of failed and successful experiments is more useful than the web interface or the best recorded EER. It shows where a convincing metric can lie.

## The test is built around unfamiliar attacks

The project uses the Logical Access partition of ASVspoof 2019. Logical Access covers speech synthesized or converted before it reaches a telephony channel. The training and development partitions contain attacks A01 through A06. The evaluation partition contains A07 through A19.

That split matters. Evaluation is not another random sample of the attacks used for training. It asks whether a detector has learned evidence of synthetic speech that transfers to different generation systems.

There is an important catch. Results from the evaluation partition later influenced loss choices, model removal, and fusion weights. That turns the work into a retrospective engineering study, not an unbiased final estimate on an untouched test set. A clean follow-up would make those choices on development data and reserve another corpus or partition for the final comparison.

The saved notebook outputs record 25,380 training samples, 24,844 development samples, and 71,237 evaluation samples. The evaluation set contains 7,355 bonafide recordings and 63,882 spoofed recordings. Each of the thirteen evaluation attacks contributes 4,914 samples.

The class ratio creates an easy trap. Spoof is label 1 throughout the code, and a constant spoof prediction earns 89.68% evaluation accuracy. That is exactly what the collapsed ResNet did. Its AUC of 0.5425 and EER of 47.57% were much closer to the truth.

Equal error rate is the operating point where the bonafide false-alarm rate and spoof miss rate are approximately equal. Lower is better. It summarizes performance without committing to the fixed 0.5 decision threshold used elsewhere in the project. AUC describes ranking across the full threshold range. The EER implementation finds the closest point on the discrete ROC curve, so its value is an estimate rather than an interpolated crossing.

## The pipeline in concrete terms

The executable path through the repository is straightforward.

```text
ASVspoof protocol files
    -> metadata CSV files
    -> four seconds of 16 kHz mono audio
    -> cached Mel spectrogram or LFCC array
    -> PyTorch DataLoader
    -> one-logit CNN
    -> sigmoid spoof score
    -> EER, AUC, threshold metrics, and per-attack results
```

[`scripts/01_prepare_metadata.py`](scripts/01_prepare_metadata.py) parses the official protocol files and joins each row to its FLAC file. [`scripts/02_extract_features.py`](scripts/02_extract_features.py) writes one NumPy array per recording. Training then reads those arrays instead of recomputing audio features every epoch. That choice saves a lot of repeated CPU work and makes model iteration less painful.

The audio frontend in [`src/data/audio_loader.py`](src/data/audio_loader.py) converts stereo to mono, resamples to 16 kHz, and forces every recording to 64,000 samples. Longer recordings lose everything after the first four seconds. Short recordings receive zero padding at the end. There is no loudness normalization, voice activity detection, or random crop.

Those details are part of the model, even though they sit outside the neural network. A long fake with its strongest artifact after four seconds will never show that evidence to the classifier. A short clip always has silence on the right, which gives the network a possible duration cue.

## Two views of the same waveform

The project compares log-Mel spectrograms with Linear Frequency Cepstral Coefficients.

The Mel frontend uses 128 bands, a 2,048-sample FFT, and a 512-sample hop. A four-second recording becomes an array close to 128 by 126. The code converts power to decibels, clips the dynamic range to 80 dB, then independently scales each recording to the range zero through one.

That last operation trades information for invariance. It makes recordings with different levels easier to compare, but it removes absolute energy scale. This design choice affects what the model can learn.

The LFCC frontend uses 60 coefficients, a 1,024-sample FFT and window, and a 256-sample hop. The saved notebook output shows a 60 by 251 array. The motivation is that linear frequency spacing may retain synthesis evidence in regions that a perceptual Mel scale compresses. This repository does not isolate that mechanism in an ablation. Unlike the Mel path, the LFCC arrays are not normalized per recording.

Training applies SpecAugment only to the training split. It cuts random strips out of the frequency and time axes. The development and evaluation features remain untouched. Both frontends use the same downstream contract, a float tensor with shape `channels, frequency, time`.

## Five models, one output convention

Every model returns one raw logit. Training uses `BCEWithLogitsLoss`, and inference applies a sigmoid to obtain a spoof score. Keeping this convention across architectures made evaluation and score fusion simple.

The Mel baseline has three convolutional blocks and 25,633 trainable parameters. Each block uses convolution, batch normalization, ReLU, and max pooling. Adaptive average pooling reduces the final feature map before a small fully connected head.

The LFCC baseline has 31,969 parameters. It pools only along time inside its convolutional stack, preserving the smaller 60-coefficient axis until global pooling.

The ResNet-18 model has 11,170,753 parameters. It starts from ImageNet weights, replaces the RGB input convolution with one channel, and initializes that channel by summing the three original kernels. The corrected training run combined summed kernels with disabled mixed precision, after an earlier run produced near-constant scores. No controlled ablation separates the effect of those two changes. The model fine-tunes all layers rather than freezing an image backbone and training only a new head.

The custom Thin ResNet-34 keeps the familiar 3, 4, 6, 3 residual block pattern but narrows the stages to 16, 24, 32, and 64 channels. It has 370,401 parameters. There is no initial max pool, so the model retains more LFCC resolution near the input.

The LCNN is smaller still at 76,002 parameters. Its Max-Feature-Map units split channels in half and retain the larger activation at each location. A learned sigmoid mask weights the final spatial map before classification. The pooling operation is an unnormalized weighted sum, an implementation detail worth remembering if input sizes change.

## Training exposed numerical and statistical failures

The trainer supports Adam, AdamW, and SGD, several learning-rate schedulers, gradient clipping, early stopping, checkpointing, and local MLflow logging. The active profiles all use ordinary binary cross entropy. Model selection follows development loss.

The experiments were less tidy than that list makes them sound.

Mixed precision produced NaNs in at least one Thin ResNet run. It was disabled for Thin ResNet, LCNN, and ResNet-18. A separate class-weighting attempt set the positive spoof weight to 0.11. That made spoof errors cheap and recall collapsed to about 60%. The current profiles use no class weight. The all-spoof ResNet failure came from another run and should not be confused with the weighting experiment.

The strongest warning came from the development split. Training logs show several runs near 99.98% development accuracy, while separately saved evaluation outputs range from 7.89% to 19.85% EER. The artifacts lack immutable run IDs and checkpoint hashes, so they cannot always be paired run for run. Even so, the broad pattern is clear. Performance on development attacks A01 through A06 did not predict performance on evaluation attacks A07 through A19.

This is why the project records per-attack output. A smooth validation curve cannot tell you that one synthesis method has found a hole in the detector.

## What the experiments actually measured

The saved console outputs contain the following results on 71,237 evaluation samples.

| Model | Parameters | AUC | EER |
| --- | ---: | ---: | ---: |
| Baseline CNN with Mel | 25,633 | 0.9215 | 14.10% |
| Baseline CNN with LFCC | 31,969 | 0.9105 | 15.18% |
| Thin ResNet-34 with LFCC, best recorded run | 370,401 | 0.9385 | 12.85% |
| LCNN with LFCC | 76,002 | 0.9420 | 11.99% |
| ResNet-18 with LFCC | 11,170,753 | 0.9741 | 7.89% |
| Historical ResNet-34 with Mel | 21,278,913 | 0.9767 | 7.90% |
| Best recorded score fusion | Two models | 0.9945 | 3.14% |

The full ResNet-34 result is useful because it rules out an easy assumption. Doubling the parameter count from ResNet-18 produced almost the same EER, 7.90% instead of 7.89%. The smaller Thin ResNet and LCNN gave up accuracy, but their size makes the trade visible rather than vague. LCNN used less than one percent of the ResNet-18 parameter count and reached 11.99% EER.

The fixed-threshold metrics need more care. Most successful runs had EER thresholds between 0.0001 and 0.0094, nowhere near the 0.5 threshold used for printed accuracy, recall, and F1. The models rank many samples correctly while producing poorly calibrated scores. Calling the sigmoid output a confidence value hides that fact.

## The attack table is where the result becomes uncomfortable

The corrected ResNet-18 looked strong in aggregate. It reached 7.89% EER and 0.9741 AUC. At the fixed 0.5 threshold it correctly detected more than 94% of every attack from A07 through A16.

Then came A17 and A18.

| Attack | ResNet-18 LFCC accuracy | Mel baseline accuracy | Best recorded fusion accuracy |
| --- | ---: | ---: | ---: |
| A10 | 96.70% | 23.67% | 56.17% |
| A12 | 95.52% | 24.44% | 48.47% |
| A15 | 99.02% | 7.02% | 41.64% |
| A17 | 1.38% | 26.88% | 4.48% |
| A18 | 2.81% | 79.87% | 25.91% |

The Mel baseline was mediocre overall, yet it was far better than ResNet-18 on A18. ResNet-18 handled A10, A12, and A15 almost perfectly while the baseline failed most samples. The models had different blind spots.

That complementarity motivated score fusion. The recorded best run averaged the two spoof scores and reduced EER from 7.89% to 3.14%. That is a 4.75 percentage point drop and about a 60% relative reduction. AUC rose to 0.9945.

Fusion did not make the hard attacks disappear. A17 accuracy remained 4.48% at the fixed threshold. The global ranking improved because errors from the two models offset each other across much of the dataset, but both still struggled with the same attack. This is the distinction I would want to know before deploying the detector.

There is also a bookkeeping problem. The score averages in the two saved ensemble outputs indicate equal weights and a 70% ResNet weighting. The current evaluator uses 60% ResNet and 40% baseline, while the README diagram describes 70% ResNet and 30% baseline. No saved result matches the current 60/40 code. The repository also lacks the ResNet-18 checkpoint required to rerun any ensemble. The 3.14% result is recorded evidence, but it cannot be reproduced from the current checkout.

## Explanations help inspection, not proof

The project implements Grad-CAM and Integrated Gradients with NoiseTunnel. Grad-CAM targets the final convolutional block of each model and upsamples its coarse activation map. Integrated Gradients attributes the prediction back to individual input values, while NoiseTunnel averages noisy samples to reduce visual speckle.

Both methods can answer a useful debugging question. Which time and feature regions most influenced this prediction?

The 56 committed images cover two models, the Mel baseline and ResNet-18, with both explanation methods. Each set contains one bonafide example and one example for every evaluation attack. These images cannot prove that a colored patch contains a vocoder artifact. The maps report model attribution rather than acoustic ground truth. They are individually normalized, so color intensity cannot be compared directly across samples. The batch scripts also choose random examples without recording the source filename in the output name.

The ensemble has an extra wrinkle. Its final score combines two models operating on different features, but the Gradio interface displays only the ResNet explanation. That image explains one component, not the fused decision. A proper ensemble view should show both component scores and both attribution maps, then avoid claiming either heatmap explains the weighted sum by itself.

## What I would fix before another benchmark run

Reproducibility comes first. Every evaluation should save raw score vectors and the exact fusion recipe. Each checkpoint should include its preprocessing configuration, decision threshold, Git revision, and dataset manifest. A text table rounded to four decimals cannot support threshold recalculation or confidence intervals. The current checkpoints can also be loaded with whatever YAML happens to be in the working tree, while cached features carry no record of the settings that produced them.

Thresholding is the next practical problem. The web app uses 0.5 even though recorded EER thresholds are orders of magnitude smaller. Its displayed confidence is not a calibrated probability. A deployment needs a threshold selected on development data for a stated false-alarm cost, followed by calibration checks on data that did not influence model selection.

Benchmarking should use the official ASVspoof scoring code and report min t-DCF alongside EER. Several seeds would show whether an improvement survives initialization noise. The final estimate also needs data that did not guide architecture, loss, or fusion decisions.

A second corpus matters more than another decimal place on ASVspoof 2019 LA. Four-second crops from one benchmark cannot establish performance on compressed social-media audio, room recordings, partial fakes, or newer generators. A17 and A18 also deserve experiments of their own. Segment-level inference, waveform augmentation, alternative frontends, and attack-balanced sampling are reasonable candidates, provided each receives a controlled comparison.

## The result I trust most

It would be easy to end with 3.14% EER. The collapsed run teaches more.

The result I trust most is the embarrassing one. A detector reached 89.68% accuracy by learning almost nothing useful. Per-attack evaluation caught it. EER made the collapse obvious. Later experiments cut the error sharply, yet A17 still defeated nearly every model.

Audio deepfake detection is not one binary classification problem. It is a moving collection of generation methods, recording conditions, codecs, and thresholds. A detector can look excellent in aggregate while missing nearly every sample from one attack family. This project made that failure visible, and that is more valuable than a polished accuracy number.

The reported evaluation tables come from [`docs/results.txt`](docs/results.txt) and [`ensemble.txt`](ensemble.txt). Dataset counts come from the saved notebook outputs, while training behavior comes from local logs and [`CHANGELOG.md`](CHANGELOG.md). The current pipeline lives under [`src`](src), with runnable stages under [`scripts`](scripts) and the interactive application under [`app`](app). Raw evaluation scores are absent, so the rounded results cannot be independently recomputed.
