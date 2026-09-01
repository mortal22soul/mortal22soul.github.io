---
title: "Working on image super-resolution"
description: "What I learned while implementing and training SRCNN for image super-resolution."
date: "Nov 2 2025"
draft: false
---

This semester I implemented the Super-Resolution Convolutional Neural Network, or SRCNN, described by [Dong et al., 2014](https://arxiv.org/abs/1501.00092). I prepared the dataset, extracted patches, trained the model in the cloud, tracked the experiments, and evaluated the results. It involved more engineering than I expected. Here is what I built and what I learned.

## What is super-resolution?

Single image super-resolution, or SISR, takes a low-resolution image and tries to recover its high-resolution version. I will call these LR and HR images. The problem is ill-posed because many HR images could produce the same LR image after downscaling. The network therefore has to learn the statistical patterns found in natural images.

Bicubic interpolation is the classical baseline. It is fast, but the results look blurry because it averages nearby pixels and cannot recover fine edges or textures. SRCNN learns the LR to HR mapping from data instead.

The architecture has a separate convolutional layer for each of its three stages: patch extraction, non-linear mapping, and reconstruction.

## The model

The full model lives in `srcnn_model.py`:

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

The model has three layers and about 57K parameters. SRCNN does no upsampling inside the network. It expects an input that has already been upsampled with bicubic interpolation to the HR dimensions, then sharpens and corrects that blurry image.

## Dataset and preprocessing

I used [DIV2K](https://data.vision.ee.ethz.ch/cvl/DIV2K/), which contains 800 training images and 100 validation images at 2K resolution. Batching the full images on a GPU is impractical, so I first cropped them into patches.

### Step 1. Patch extraction

`preprocess/extraxt_subimages.py` runs a sliding window over each image. Adjacent patches overlap by 50%, and the script uses 20 parallel threads:

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

The worker crops each image in a nested loop and saves patches with names such as `{img}_s001.png` and `{img}_s002.png`. HR and LR patches share a base filename. `DIV2KDataset` uses that filename to load matched pairs:

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

This step takes 10 to 30 minutes and uses roughly two to three times as much storage as the original images.

### Step 2. Upload to S3

I trained on AWS, so I synced the preprocessed patches to an S3 bucket from a SageMaker Studio terminal:

```bash
aws s3 sync DIV2K_train_HR_sub       s3://your-bucket/DIV2K_train_HR/
aws s3 sync DIV2K_train_LR_bicubic/X2_sub s3://your-bucket/DIV2K_train_LR_bicubic/X2/
aws s3 sync DIV2K_valid_HR_sub       s3://your-bucket/DIV2K_valid_HR/
# repeat for X3, X4 and validation LR splits
```

At launch, SageMaker mounts a local copy that the training script reads.

## Training environment

I trained in AWS SageMaker Studio on an `ml.g4dn.xlarge` instance with one NVIDIA T4 GPU, 16 GB of VRAM, 4 vCPUs, and 16 GB of RAM. The T4's Tensor Cores support mixed-precision training well. In this project, mixed precision was faster than float32.

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

Changing `"scale"` and running `train_srcnn_final.py` again trains the model for another upscaling factor. Each scale writes to its own checkpoint directory: `checkpoints-x2/`, `checkpoints-x3/`, or `checkpoints-x4/`.

I used MSE loss between the SR output and the HR ground truth. It is a straightforward choice for pixel regression, though it tends to smooth details more than perceptual losses do.

The optimizer is Adam with a learning rate of `1e-4`. `ReduceLROnPlateau` halves that rate when validation PSNR plateaus for 5 epochs.

For mixed precision, I used AMP with `GradScaler`. It sped up training on the T4 without reducing accuracy:

```python
scaler = torch.amp.GradScaler("cuda", enabled=config["use_amp"])

with torch.amp.autocast("cuda", enabled=config["use_amp"]):
    sr = model(lr)
    loss = criterion(sr, hr)

scaler.scale(loss).backward()
scaler.step(optimizer)
scaler.update()
```

The script saves `best_psnr.pth` whenever validation PSNR improves and saves `epoch_N.pth` every 5 epochs. Each checkpoint contains the model, optimizer, and scaler state, so a resumed run continues with the same weights and training state.

Early stopping triggers after 10 epochs without improvement. Both the X2 and X3 models stopped well before epoch 50.

## Metrics and MLflow tracking

Each epoch, `torchmetrics` computes PSNR and SSIM on the validation set. The script logs both values to MLflow:

```python
psnr_metric = PeakSignalNoiseRatio(data_range=1.0).to(device)
ssim_metric = StructuralSimilarityIndexMeasure(data_range=1.0).to(device)

# per validation batch
psnr_metric.update(sr_val, hr_val)
ssim_metric.update(sr_val, hr_val)

mlflow.log_metric("val_psnr", psnr_metric.compute().item(), step=epoch)
mlflow.log_metric("val_ssim", ssim_metric.compute().item(), step=epoch)
```

Every 5 epochs, `utils.save_sample_image()` writes a side-by-side LR, SR, and HR comparison to `outputs/` and logs it as an MLflow artifact. At the end of training, `mlflow.pytorch.log_model()` logs the model and an inferred signature that records the expected input and output shapes.

Running `mlflow ui` opens `http://localhost:5000`, where I compared the runs for all three scales.

## Inference

`inference.py` runs the trained model on Set5 and Set14. For each image, it simulates the degradation, runs the model, and computes PSNR and SSIM:

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

The `.clamp(0, 1)` call is necessary. Without it, pixel values just outside the valid range cause artifacts in the saved image.

For each input image, the script writes `_LR.png`, `_SR.png`, `_HR.png`, and `_compare.png`.

## Results

* https://github.com/mortal22soul/SRCNN/tree/main/results-set5
* https://github.com/mortal22soul/SRCNN/tree/main/results-set14

Set14 scores are lower because images such as `baboon`, with fur, and `barbara`, with fabric, contain dense high-frequency textures. SRCNN tends to smooth those textures.

The `butterfly` image from Set5 went better. Its wing edge patterns are visibly sharper in the SR output than in the bicubic baseline, although they do not perfectly reconstruct the HR ground truth.

## What I learned

Patch-based training was necessary. I could not batch full 2K images at a useful batch size. Splitting each image into about 40 patches of 480×480 pixels with 50% overlap produced a larger training set without changing the data distribution.

Upsampling with bicubic interpolation first has a cost. SRCNN operates at HR resolution, including during inference. That simplifies the learning problem but slows inference. Later models such as ESPCN run their convolutions at LR resolution, then perform learnable sub-pixel upsampling at the end. That approach requires much less computation.

AMP took only five extra lines. On the T4, `torch.amp.autocast` with `GradScaler` cut training time without reducing accuracy. That was an easy win.

Larger scale factors make the problem harder. X4 PSNR is well below X2 because the model must recover four times as much missing detail from the same input. This is where more expressive architectures such as EDSR and ESRGAN start to make sense.

## References

* [Image Super-Resolution Using Deep Convolutional Networks](https://arxiv.org/abs/1501.00092), Dong et al., ECCV 2014
* [DIV2K Dataset](https://data.vision.ee.ethz.ch/cvl/DIV2K/)
* [Set5 and Set14 benchmarks](https://github.com/jbhuang0604/SelfExSR)
