"""Persistent CPU ASR worker in its own venv (separate transformers version)."""
import base64
import contextlib
import json
from pathlib import Path
import sys
import time


def normalize(result, duration_ms):
    segments = []
    for sentence in result.get("sentence_info", []):
        text = str(sentence.get("text", "")).strip()
        start, end = int(sentence.get("start", 0)), int(sentence.get("end", 0))
        if text and 0 <= start < end <= duration_ms + 100:
            segments.append({"start_ms": start, "end_ms": min(end, duration_ms), "text": text})
    text = str(result.get("text", "")).strip()
    if text and not segments:
        stamps = result.get("timestamp", [])
        start = int(stamps[0][0]) if stamps else 0
        end = int(stamps[-1][1]) if stamps else duration_ms
        segments = [{"start_ms": max(0, start), "end_ms": min(duration_ms, end), "text": text}]
    timestamps = [[int(t[0]), int(t[1])] for t in result.get("timestamp", [])]
    return {"text": text, "segments": segments, "timestamps": timestamps,
            "timestamp_source": "model" if timestamps else "vad" if segments else "none",
            "model": "FunASR/Paraformer-zh", "device": "cpu", "language": "zh"}


def main():
    root = Path(sys.argv[1])
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from funasr import AutoModel
        model = AutoModel(model=str(root / "models/paraformer"), vad_model=str(root / "models/vad"),
                          punc_model=str(root / "models/punc"), device="cpu", ncpu=4, disable_update=True,
                          vad_kwargs={"max_single_segment_time": 20000})
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if "audio_path" in request:
                # Decode/resample with ffmpeg, including MP3/AAC and long songs.
                import subprocess
                duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                                         "-of", "default=noprint_wrappers=1:nokey=1", request["audio_path"]], text=True).strip())
                if not 0.1 <= duration <= 1800:
                    raise ValueError("ASR file must be 0.1s to 30min")
                decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", request["audio_path"], "-f", "f32le",
                                          "-ar", "16000", "-ac", "1", "-t", "1800", "pipe:1"], check=True, stdout=subprocess.PIPE).stdout
                audio = np.frombuffer(decoded, dtype="<f4").copy()
            else:
                audio = np.frombuffer(base64.b64decode(request["audio"], validate=True), dtype="<i2").astype(np.float32) / 32768
            duration = round(len(audio) / 16)
            if not 100 <= duration <= 1800000:
                raise ValueError("ASR audio must be 0.1s to 30min")
            started = time.monotonic()
            with contextlib.redirect_stdout(sys.stderr):
                results = model.generate(input=audio, fs=16000, batch_size_s=60, sentence_timestamp=True)
            response = normalize(results[0] if results else {}, duration)
            response["inference_ms"] = round((time.monotonic() - started) * 1000)
            response["request_id"] = request["request_id"]
            print(json.dumps(response, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
