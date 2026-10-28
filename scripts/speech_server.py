"""Loopback speech API: FunASR Chinese ASR + OmniVoice FlashInfer CUDA Graph TTS."""
import argparse
import base64
from collections import OrderedDict
from contextvars import ContextVar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path, PureWindowsPath
import re
import selectors
import signal
import subprocess
import sys
import threading
import time
import uuid

MODEL = "k2-fsa/OmniVoice"
current_cancel = ContextVar("current_cancel", default=None)


class Cancelled(Exception):
    pass


def spoken_text(value):
    if not isinstance(value, str):
        raise ValueError("TTS input must be spoken text")
    text = value.strip()
    if (text.startswith(("{", "}", "[", "]", "`", "<think>"))
            or re.match(r'^"[a-z_]+"\s*:', text, re.I)
            or not any(ch.isalnum() for ch in text)):
        raise ValueError("TTS accepts spoken answers only; JSON, emotion/action fields and empty punctuation are not speech")
    return text


class InvalidWaveform(RuntimeError):
    pass


def encode_pcm(wave):
    import numpy as np
    wave = np.asarray(wave, dtype=np.float32).reshape(-1)
    if not len(wave):
        raise InvalidWaveform("OmniVoice returned an empty waveform; no audio was sent")
    if len(wave) > 24000 * 60:
        raise InvalidWaveform(f"OmniVoice returned {len(wave) / 24000:.1f}s audio (limit 60s); no audio was sent")
    invalid = int((~np.isfinite(wave)).sum())
    if invalid:
        raise InvalidWaveform(f"OmniVoice returned {invalid} non-finite samples out of {len(wave)}; no audio was sent")
    return (np.clip(wave, -1, 1) * 32767).astype("<i2").tobytes()


def local_path(value):
    value = str(value).strip().strip("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\"").strip()
    win = PureWindowsPath(value)
    if re.match(r"^[A-Za-z]:[\\/]", value):
        return Path("/mnt") / win.drive[0].lower() / Path(*win.parts[1:])
    if not value.startswith("/"):
        raise ValueError("Audio path must be absolute (Windows or WSL)")
    return Path(value)


class ASRWorker:
    def __init__(self, root, scripts):
        self.process = subprocess.Popen([str(root / "asr/bin/python"), "-u", str(scripts / "funasr_worker.py"), str(root)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.lock = threading.Lock()
        if self.receive(180).get("ready") is not True:
            raise RuntimeError("FunASR failed to initialize")

    def receive(self, timeout):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout):
                self.process.kill()
                raise RuntimeError("FunASR inference timed out; restart speech service")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("FunASR worker exited; restart speech service")
        result = json.loads(line)
        if "error" in result:
            raise ValueError(result["error"])
        return result

    def transcribe(self, body):
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("FunASR is processing another recording")
        try:
            if self.process.poll() is not None:
                raise RuntimeError("FunASR worker exited; restart speech service")
            request = {"request_id": str(uuid.uuid4())}
            if "audio_path" in body:
                path = local_path(body["audio_path"])
                if not path.is_file() or path.stat().st_size > 100 * 1024 * 1024:
                    raise ValueError("Audio file missing or larger than 100MB")
                request["audio_path"] = str(path)
            else:
                if body.get("sample_rate") != 16000 or body.get("format") != "pcm_s16le":
                    raise ValueError("ASR requires mono PCM s16le at 16000Hz")
                raw = base64.b64decode(body.get("audio", ""), validate=True)
                if not 3200 <= len(raw) <= 800000 or len(raw) % 2:
                    raise ValueError("ASR PCM must be 0.1 to 25 seconds")
                request["audio"] = body["audio"]
            self.process.stdin.write(json.dumps(request) + "\n")
            self.process.stdin.flush()
            result = self.receive(1200 if "audio_path" in request else 120)
            if result.get("request_id") != request["request_id"]:
                self.process.kill()
                raise RuntimeError("FunASR response out of sequence; restart service")
            return result
        finally:
            self.lock.release()


class SpeechService:
    def __init__(self, root, scripts):
        self.ready = False
        self.failure = None
        self.model = None
        self.asr = None
        self.root, self.scripts = root, scripts
        self.tts_lock = threading.Lock()
        self.requests_lock = threading.Lock()
        self.active = {}
        self.cancelled = OrderedDict()
        self.prompts = OrderedDict()
        self.acceleration = {"flashinfer": False, "cuda_graph": False, "verified": False}

    def initialize(self):
        try:
            import torch
            from omnivoice import OmniVoice
            from omnivoice.models.omnivoice_flashinfer import apply_flashinfer
            if not torch.cuda.is_available():
                raise RuntimeError("OmniVoice FlashInfer requires a WSL2 CUDA GPU")
            self.model = OmniVoice.from_pretrained(str(self.root / "models/omnivoice"), device_map="cuda", dtype=torch.float16, load_asr=False)
            # A fixed duration-bucket set bounds graph cache growth during long live sessions.
            apply_flashinfer(self.model, enable_cuda_graph=True, cuda_graph_buckets=[4, 8, 16, 32, 60])
            # Both eager inference and FlashInfer CUDA graph replay use this step hook.
            predict = self.model._predict_tokens_with_scoring
            def checked_predict(*args, **kwargs):
                cancel = current_cancel.get()
                if cancel is not None and cancel.is_set():
                    raise Cancelled("TTS request cancelled")
                return predict(*args, **kwargs)
            self.model._predict_tokens_with_scoring = checked_predict
            # Execute actual kernels before advertising acceleration as verified.
            with torch.inference_mode():
                warmup = self.model.generate(text="你好。", language="zh", num_step=32)[0]
            if len(warmup) == 0:
                raise RuntimeError("OmniVoice warmup produced no audio")
            impl = self.model.llm.config._attn_implementation
            graph = bool(getattr(self.model, "_fi_enable_cuda_graph", False))
            if impl != "omnivoice_fi" or not graph or not self.model._fi_graph_cache:
                raise RuntimeError("FlashInfer/CUDA Graph activation check failed")
            self.acceleration = {"flashinfer": True, "cuda_graph": graph, "verified": True,
                                 "gpu": torch.cuda.get_device_name(0)}
            self.asr = ASRWorker(self.root, self.scripts)
            self.ready = True
            print("Speech service ready: FunASR + OmniVoice, FlashInfer/CUDA Graph verified", flush=True)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.failure = str(e)

    def health(self):
        asr_alive = self.asr is not None and self.asr.process.poll() is None
        return {"ready": self.ready and asr_alive, "backend": "omnivoice-funasr-wsl2", "model": MODEL, "device": "cuda (WSL2)",
                "stt": {"ready": self.ready and asr_alive,
                        "model": "FunASR/Paraformer-zh", "device": "cpu", "endpoint": "/api/stt"},
                "acceleration": self.acceleration, "error": self.failure or ("FunASR worker exited; restart service" if self.ready and not asr_alive else None), "tts_endpoint": "/api/tts"}

    def cancel(self, request_id):
        with self.requests_lock:
            for event in self.active.get(request_id, []):
                event.set()
            # Cancel can arrive before a queued sentence registers.
            self.cancelled[request_id] = time.monotonic()
            while len(self.cancelled) > 256:
                self.cancelled.popitem(last=False)

    def tts(self, body):
        if body.get("model", MODEL) != MODEL:
            raise ValueError("This service uses k2-fsa/OmniVoice")
        text = spoken_text(body.get("input", ""))
        ref_text = str(body.get("ref_text", "")).strip()
        if not text or len(text) > 200 or not ref_text or len(ref_text) > 2000:
            raise ValueError("TTS requires 1-200 input characters and reference transcript")
        import torch
        path = local_path(body.get("ref_audio", ""))
        if not path.is_file():
            raise ValueError("Reference recording not found in WSL: " + str(path))
        request_id = str(body.get("request_id") or uuid.uuid4())
        if len(request_id) > 128:
            raise ValueError("Invalid request_id")
        event = threading.Event()
        with self.requests_lock:
            if request_id in self.cancelled:
                raise Cancelled("TTS request cancelled")
            self.active.setdefault(request_id, []).append(event)
        token = current_cancel.set(event)
        try:
            # At most one inference + one waiting sentence, no unbounded request queue.
            if not self.tts_lock.acquire(timeout=1):
                raise BlockingIOError("OmniVoice is processing another sentence")
            try:
                if event.is_set():
                    raise Cancelled("TTS request cancelled")
                stat = path.stat()
                cache_key = (str(path), stat.st_mtime_ns, stat.st_size, ref_text)
                with torch.inference_mode():
                    if cache_key not in self.prompts:
                        self.prompts[cache_key] = self.model.create_voice_clone_prompt(ref_audio=str(path), ref_text=ref_text)
                        while len(self.prompts) > 2:
                            self.prompts.popitem(last=False)
                    wave = self.model.generate(text=text, language="zh", voice_clone_prompt=self.prompts[cache_key], num_step=32)[0]
                if event.is_set():
                    raise Cancelled("TTS request cancelled")
                try:
                    return encode_pcm(wave)
                except InvalidWaveform as e:
                    print(f"TTS waveform failure request_id={request_id} input_chars={len(text)}: {e}", file=sys.stderr, flush=True)
                    raise
            finally:
                self.tts_lock.release()
        finally:
            current_cancel.reset(token)
            with self.requests_lock:
                events = self.active.get(request_id, [])
                if event in events:
                    events.remove(event)
                if not events:
                    self.active.pop(request_id, None)


class Handler(BaseHTTPRequestHandler):
    def send(self, code, data, content_type="application/json", headers=None):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != "/health":
            return self.send(404, {"error": "Unknown endpoint"})
        return self.send(200, self.server.service.health())

    def do_POST(self):
        try:
            if self.path not in ("/api/stt", "/api/tts", "/api/tts/cancel"):
                return self.send(404, {"error": "Unknown endpoint"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1200000:
                return self.send(413, {"error": "Request too large"})
            self.connection.settimeout(10)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("JSON object required")
            service = self.server.service
            if self.path == "/api/tts/cancel":
                service.cancel(str(body.get("request_id", "")))
                return self.send(200, {"cancelled": True})
            if not service.ready:
                return self.send(503, {"error": service.failure or "Models still loading"})
            if self.path == "/api/stt":
                return self.send(200, service.asr.transcribe(body))
            pcm = service.tts(body)
            return self.send(200, pcm, "application/octet-stream", {"X-Audio-Sample-Rate": "24000", "X-Audio-Channels": "1", "X-Audio-Format": "s16le"})
        except Cancelled as e:
            self.send(409, {"error": str(e)})
        except BlockingIOError as e:
            self.send(429, {"error": str(e)})
        except InvalidWaveform as e:
            self.send(502, {"error": str(e), "code": "invalid_tts_waveform"})
        except (ValueError, OSError) as e:
            self.send(400, {"error": str(e)})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send(500, {"error": str(e)})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--scripts", type=Path, required=True)
    a = p.parse_args()
    service = SpeechService(a.root, a.scripts)
    server = ThreadingHTTPServer(("127.0.0.1", 8766), Handler)
    server.daemon_threads = True
    server.service = service
    threading.Thread(target=service.initialize, daemon=True).start()
    # Windows reaches this loopback-only listener through WSL2 localhost forwarding.
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
