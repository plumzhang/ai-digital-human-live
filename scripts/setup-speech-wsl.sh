#!/usr/bin/env bash
set -euo pipefail
root=/opt/innotechx-speech
scripts="$1"
export DEBIAN_FRONTEND=noninteractive
export PIP_DISABLE_PIP_VERSION_CHECK=1
apt-get update
apt-get install -y python3-venv python3-dev build-essential ninja-build libsndfile1 ffmpeg git curl ca-certificates
# Minimal CUDA compiler/headers for FlashInfer kernels; WSL uses the Windows driver.
if [ ! -x /usr/local/cuda-12.8/bin/nvcc ]; then
  curl --fail --location --retry 3 -o /tmp/speech-cuda-keyring.deb https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
  dpkg -i /tmp/speech-cuda-keyring.deb
  apt-get update
  apt-get install -y cuda-nvcc-12-8 cuda-cudart-dev-12-8
fi
export CUDA_HOME=/usr/local/cuda-12.8
export PATH="$CUDA_HOME/bin:$PATH"
mkdir -p "$root/models"
# The official acceleration module is not in the PyPI 0.2.1 wheel.
# Pin the upstream source revision containing OmniVoice's FlashInfer integration.
revision=08be0b4ccbac3e13e374e86fbfead4b4cac343e2
if [ ! -d "$root/OmniVoice/.git" ]; then
  git -c http.proxy= -c https.proxy= clone https://github.com/k2-fsa/OmniVoice.git "$root/OmniVoice"
fi
git -C "$root/OmniVoice" -c http.proxy= -c https.proxy= fetch origin "$revision"
git -C "$root/OmniVoice" checkout --detach "$revision"
python3 -m venv "$root/tts"
python3 -m venv "$root/asr"
"$root/tts/bin/pip" install --upgrade pip
mkdir -p "$root/wheels"
"$root/tts/bin/pip" install 'torch==2.8.0+cu128' 'torchaudio==2.8.0+cu128' --find-links "$root/wheels" --extra-index-url https://download.pytorch.org/whl/cu128
"$root/tts/bin/pip" install "$root/OmniVoice" 'transformers==5.3.0' 'librosa==0.11.0' 'numpy==2.2.6' 'huggingface-hub==1.7.2' modelscope
"$root/tts/bin/pip" install flashinfer-python==0.6.15.post1
# Optional 1.3GB precompiled cache. Without it, nvcc compiles only the local GPU's kernels.
if [ "${SPEECH_PRECOMPILED_CACHE:-0}" = 1 ]; then
  "$root/tts/bin/pip" install 'flashinfer-jit-cache==0.6.15.post1+cu128' --extra-index-url https://flashinfer.ai/whl/cu128/
fi
"$root/asr/bin/pip" install --upgrade pip
"$root/asr/bin/pip" install 'torch==2.8.0+cpu' 'torchaudio==2.8.0+cpu' --extra-index-url https://download.pytorch.org/whl/cpu
"$root/asr/bin/pip" install funasr==1.4.16 'transformers==4.57.6' modelscope soundfile
# Download once into Linux storage. Windows reference recordings remain on /mnt/*.
export HF_HUB_DISABLE_XET=1
"$root/tts/bin/python" "$scripts/download-speech-models.py" "$root"
"$root/tts/bin/python" -c 'import torch; from omnivoice.models.omnivoice_flashinfer import apply_flashinfer; assert torch.cuda.is_available(), "WSL CUDA unavailable"; print(torch.cuda.get_device_name(0))'
printf '{"schema":1,"backend":"omnivoice-funasr-wsl2","revision":"%s"}\n' "$revision" > "$root/installed.json"
echo 'Installed. Start the speech service to warm up and verify FlashInfer/CUDA Graph kernels.'
