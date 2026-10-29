"""On-demand local two-stem separation; does not change the TTS environment."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import venv


def prepare(root):
    executable = root / "separator/bin/python"
    if not executable.is_file():
        venv.create(root / "separator", with_pip=True)
    # Reuse the installed CUDA torch without pip touching the TTS environment.
    tts_python = root / "tts/bin/python"
    sites = json.loads(subprocess.check_output(
        [str(tts_python), "-c", "import json,site; print(json.dumps(site.getsitepackages()))"], text=True))
    own_site = subprocess.check_output(
        [str(executable), "-c", "import site; print(site.getsitepackages()[0])"], text=True).strip()
    Path(own_site, "innotechx_tts.pth").write_text("\n".join(sites) + "\n")
    probe = subprocess.run([str(executable), "-c",
        "import importlib.metadata; assert importlib.metadata.version('demucs') == '4.0.1'; import demucs.pretrained, demucs.apply"],
        capture_output=True)
    if probe.returncode:
        subprocess.run([str(executable), "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
                        "--timeout", "30", "--retries", "2", "demucs==4.0.1"], check=True, timeout=600)
    return executable


def separate(args):
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.manual_seed(0)
    socket.setdefaulttimeout(60)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    decoded = output / "decoded.wav"
    subprocess.run(["/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", args.source, "-vn", "-ac", "2", "-ar", "44100", "-t", "1801", "-c:a", "pcm_f32le", str(decoded)],
                   check=True, timeout=180)
    audio, rate = sf.read(decoded, dtype="float32", always_2d=True)
    if rate != 44100 or audio.shape[1] != 2 or not 44100 <= len(audio) <= 1801 * 44100 or not np.isfinite(audio).all():
        raise ValueError("歌曲解码后的采样或时长无效")
    original = torch.from_numpy(audio.T.copy())
    reference = original.mean(0)
    mean, std = reference.mean(), reference.std()
    if std < 1e-7:
        raise ValueError("歌曲没有有效声音")
    model = get_model("htdemucs")
    device = "cuda" if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] >= 3 * 1024 ** 3 else "cpu"
    with torch.inference_mode():
        separated = apply_model(model, ((original - mean) / std)[None], device=device,
                                shifts=0, split=True, overlap=0.25, progress=True, num_workers=0)[0]
    vocals = separated[model.sources.index("vocals")] * std + mean
    accompaniment = original - vocals
    if not torch.isfinite(vocals).all() or not torch.isfinite(accompaniment).all():
        raise ValueError("分离结果包含无效采样")
    # One common gain retains the original balance and additive relationship.
    peak = max(vocals.abs().max().item(), accompaniment.abs().max().item(), 1.0)
    gain = 0.98 / peak
    for name, samples in (("vocals.wav", vocals), ("accompaniment.wav", accompaniment)):
        sf.write(output / name, (samples * gain).T.numpy(), rate, subtype="PCM_16")
    decoded.unlink()
    result = {"model": "htdemucs", "device": device, "sample_rate": rate, "channels": 2,
              "frames": len(audio), "gain": gain}
    (output / "separation.json").write_text(json.dumps(result), encoding="utf-8")
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source")
    parser.add_argument("--output")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    root = Path(args.root)
    if args.run:
        separate(args)
        return
    root.mkdir(parents=True, exist_ok=True)
    with (root / "song-separation.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有歌曲正在分离人声与伴奏，请稍后重试")
        executable = prepare(root)
        if not args.prepare_only:
            if not args.source or not args.output:
                parser.error("source and output are required")
            env = dict(os.environ, TORCH_HOME=str(root / "models/separation"), TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD="1")
            subprocess.run([str(executable), str(Path(__file__).resolve()), "--run", "--root", str(root),
                            "--source", args.source, "--output", args.output], check=True, timeout=1800, env=env)


if __name__ == "__main__":
    main()
