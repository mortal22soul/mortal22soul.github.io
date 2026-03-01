---
title: "Working on image super-resolution"
description: "Exploring techniques and methods for enhancing image resolution."
date: "Nov 2 2025"
draft: false
---

This semester I implemented SRCNN — Super-Resolution Convolutional Neural Network ([Dong et al., 2014](https://arxiv.org/abs/1501.00092)) — end to end: dataset prep, patch extraction, cloud training, experiment tracking, and evaluation. More engineering than I expected. This post is a writeup of what I built and what I learned.

## What is super-resolution?

Single image super-resolution (SISR) takes a low-resolution (LR) image and tries to recover the high-resolution (HR) version. It's ill-posed — many HR images could produce the same LR after downscaling — so the network has to learn what natural images look like statistically.

Bicubic interpolation is the classical baseline. It's fast but blurry because it just averages nearby pixels and can't hallucinate fine edges or textures. SRCNN learns the LR → HR mapping from data instead.

The architecture formalizes three stages: patch extraction, non-linear mapping, and reconstruction — each one a separate convolutional layer.

## The model

Full model in `srcnn_model.py`:

```python
class SRCNN(nn.Module):
    def __init__(self):
        super(SRCNN, self).__init__()
        self.net = nn.Sequential(
            nn.Conv2d(3, 64, kernel_size=9, padding=4),   # patch extraction
            nn.ReLU(inplace=True),
            nn.Conv2d(64, 32, kernel_size=5, padding=2),  # non-linear mapping
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 3, kernel_size=5, padding=2)    # reconstruction
        )

    def forward(self, x):
        return self.net(x)
```

Three layers, ~57K parameters. No upsampling inside the network — SRCNN expects the input to already be bicubically upsampled to HR size. The network's only job is to sharpen and correct that blurry upsampled image.

## Dataset and preprocessing

I used [DIV2K](https://data.vision.ee.ethz.ch/cvl/DIV2K/) — 800 training images and 100 validation images at 2K resolution. Full 2K images can't be batched on a GPU efficiently, so the first step is cropping them into patches.

### Step 1 — Patch extraction

`preprocess/extraxt_subimages.py` runs a sliding window over each image with 50% overlap using 20 parallel threads:

```python
opt = {
    'n_thread': 20,
    'compression_level': 3,
    'input_folder': 'DIV2K_train_HR',
    'save_folder': 'DIV2K_train_HR_sub',
    'crop_size': 480,   # HR patch size
    'step': 240,        # 50% overlap
    'thresh_size': 0,
}
extract_subimages(opt)
```

The worker crops each image in a nested loop and saves patches named `{img}_s001.png`, `{img}_s002.png`, etc. HR and LR patches share the same base filename, which is how `DIV2KDataset` loads matched pairs:

```python
hr_names = sorted([f for f in os.listdir(hr_dir) if f.lower().endswith(".png")])
lr_names = set(f for f in os.listdir(lr_dir) if f.lower().endswith(".png"))
self.filenames = [f for f in hr_names if f in lr_names]
```

Preprocessing parameters per scale:

| Dataset        | Crop size | Step | Patches/image |
| -------------- | --------- | ---- | ------------- |
| HR (train/val) | 480×480   | 240  | ~40           |
| LR X2          | 240×240   | 120  | ~40           |
| LR X3          | 160×160   | 80   | ~40           |
| LR X4          | 120×120   | 60   | ~40           |

This runs in 10–30 minutes and generates ~2–3x more storage than the originals.

### Step 2 — Upload to S3

Since training was on AWS, the preprocessed patches were synced to an S3 bucket from a SageMaker Studio terminal:

```bash
aws s3 sync DIV2K_train_HR_sub       s3://your-bucket/DIV2K_train_HR/
aws s3 sync DIV2K_train_LR_bicubic/X2_sub s3://your-bucket/DIV2K_train_LR_bicubic/X2/
aws s3 sync DIV2K_valid_HR_sub       s3://your-bucket/DIV2K_valid_HR/
# repeat for X3, X4 and validation LR splits
```

The training script reads from the local copy SageMaker mounts at launch time.

## Training environment

Training ran on **AWS SageMaker Studio** on a `ml.g4dn.xlarge` instance — 1× NVIDIA T4 GPU (16 GB VRAM), 4 vCPUs, 16 GB RAM. The T4's Tensor Cores make it well-suited for mixed-precision training, which gave a real speedup over float32.

## Training setup

All hyperparameters are in `config.py`:

```python
config = {
    "scale": "X2",               # "X2", "X3", or "X4"
    "batch_size": 32,
    "epochs": 50,
    "learning_rate": 1e-4,
    "upsample_lr_to_hr": True,
    "use_amp": True,
    "early_stopping_patience": 10,
    "checkpoint_every_n_epochs": 5,
    "metric_to_monitor": "psnr",
    "resume_from_checkpoint": None,
}
```

Flipping `"scale"` and re-running `train_srcnn_final.py` trains the model for a different upscaling factor. Checkpoints go into `checkpoints-x2/`, `checkpoints-x3/`, `checkpoints-x4/` respectively.

**Loss** — MSE between the SR output and HR ground truth. Straightforward for pixel regression, though it tends to over-smooth compared to perceptual losses.

**Optimizer + scheduler** — Adam at `1e-4`, with `ReduceLROnPlateau` halving the LR when validation PSNR plateaus for 5 epochs.

**Mixed precision** — AMP with `GradScaler` gave noticeable speedups on the T4 with no accuracy hit:

```python
scaler = torch.amp.GradScaler("cuda", enabled=config["use_amp"])

with torch.amp.autocast("cuda", enabled=config["use_amp"]):
    sr = model(lr)
    loss = criterion(sr, hr)

scaler.scale(loss).backward()
scaler.step(optimizer)
scaler.update()
```

**Checkpointing** — `best_psnr.pth` is saved whenever validation PSNR improves; `epoch_N.pth` is saved every 5 epochs. Each checkpoint bundles model, optimizer, and scaler state so training can be resumed cleanly.

**Early stopping** — fires after 10 epochs without improvement. Both X2 and X3 models hit this well before epoch 50.

## Metrics and MLflow tracking

PSNR and SSIM are computed on the validation set each epoch using `torchmetrics` and logged to MLflow:

```python
psnr_metric = PeakSignalNoiseRatio(data_range=1.0).to(device)
ssim_metric = StructuralSimilarityIndexMeasure(data_range=1.0).to(device)

# per validation batch
psnr_metric.update(sr_val, hr_val)
ssim_metric.update(sr_val, hr_val)

mlflow.log_metric("val_psnr", psnr_metric.compute().item(), step=epoch)
mlflow.log_metric("val_ssim", ssim_metric.compute().item(), step=epoch)
```

Every 5 epochs, `utils.save_sample_image()` saves a side-by-side LR/SR/HR comparison image to `outputs/` and logs it as an MLflow artifact. At the end of training the model is logged with `mlflow.pytorch.log_model()` along with an inferred signature so the expected input/output shapes are documented.

Running `mlflow ui` opens a dashboard at `http://localhost:5000` where you can compare all three scale runs in one place.

## Inference

`inference.py` runs the trained model on Set5 and Set14. For each image it simulates the degradation, runs the model, and computes PSNR/SSIM:

```python
def process_image(hr_path, scale=2):
    hr = Image.open(hr_path).convert("RGB")
    w, h = hr.size
    lr = hr.resize((w // scale, h // scale), Image.BICUBIC)
    lr_up = lr.resize((w, h), Image.BICUBIC)          # bicubic baseline input

    input_tensor = to_tensor(lr_up).unsqueeze(0).to(device)
    with torch.no_grad():
        sr_tensor = model(input_tensor)
    return lr_up, to_pil(sr_tensor.squeeze(0).cpu().clamp(0, 1)), hr
```

`.clamp(0, 1)` is necessary — without it, pixel values slightly out of range cause artifacts when saving.

Outputs per image: `_LR.png`, `_SR.png`, `_HR.png`, and `_compare.png`.

## Results

- https://github.com/mortal22soul/SRCNN/tree/main/results-set5
- https://github.com/mortal22soul/SRCNN/tree/main/results-set14

Set14 scores are lower because images like `baboon` (fur) and `barbara` (fabric) have dense high-frequency textures that SRCNN tends to smooth out.

The `butterfly` case from Set5 shows the opposite — the wing edge patterns are visibly sharper in the SR output than the bicubic baseline, even if they are not a perfect reconstruction of the HR ground truth.

## What I learned

**Patch-based training is non-negotiable.** Full 2K images can't be batched at a reasonable batch size. Breaking each into ~40 patches of 480×480 with 50% overlap gives you a large, diverse set without changing the data distribution.

**Bicubic-first is a tradeoff.** SRCNN operates at HR resolution (full resolution at inference). That simplifies learning but makes inference slower. Later models like ESPCN do learnable sub-pixel upsampling at the end, running convolutions at LR resolution which is much more efficient.

**AMP is five extra lines for a real win.** `torch.amp.autocast` + `GradScaler` on the T4 cut training time with zero accuracy regression.

**Higher scale = harder problem.** X4 PSNR is well below X2 — recovering 4× more missing detail from the same input is a fundamentally harder task, which motivates more expressive architectures like EDSR and ESRGAN.

## References

- [Image Super-Resolution Using Deep Convolutional Networks](https://arxiv.org/abs/1501.00092) — Dong et al., ECCV 2014
- [DIV2K Dataset](https://data.vision.ee.ethz.ch/cvl/DIV2K/)
- [Set5 and Set14 benchmarks](https://github.com/jbhuang0604/SelfExSR)
