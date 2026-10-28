"""Models use official publishers; model files stay outside the repository."""
from pathlib import Path
import fcntl
import hashlib
import os
import sys
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import snapshot_download
from modelscope import snapshot_download as ms_download

root = Path(sys.argv[1]) / "models"
root.mkdir(parents=True, exist_ok=True)
lock = (root / "download.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX)
if os.environ.get("SPEECH_MODEL_SOURCE", "modelscope") == "huggingface":
    snapshot_download("k2-fsa/OmniVoice", local_dir=root / "omnivoice")
else:
    ms_download("k2-fsa/OmniVoice", local_dir=str(root / "omnivoice"))
# ModelScope's publisher checkpoint is byte-identical to the HF checkpoint.
for filename, expected in {
    "model.safetensors": "730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa",
    "audio_tokenizer/model.safetensors": "fe7c5e8785e0a05833e1bfc3e002ec7f55af21e306b2e7154a448c1f54ccfb0d",
}.items():
    with (root / "omnivoice" / filename).open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
            raise RuntimeError("OmniVoice checkpoint SHA256 mismatch: " + filename)
for name, model in {
    "paraformer": "iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
}.items():
    ms_download(model, local_dir=str(root / name))
