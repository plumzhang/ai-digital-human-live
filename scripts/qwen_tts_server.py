"""Loopback-only Qwen3-TTS Base service. One loaded model, cached clone prompt.

Sentence synthesis is intentionally non-streaming inside a sentence. The app
pipelines LLM sentences, synthesis and paced PCM transmission independently.
"""
import argparse
import json
import threading
from contextvars import ContextVar
from collections import OrderedDict
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='Qwen/Qwen3-TTS-12Hz-0.6B-Base')
    parser.add_argument('--model-path', default='')
    parser.add_argument('--device', choices=['cuda', 'cpu'], default='cuda')
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    import numpy as np
    import torch
    import librosa
    from transformers import StoppingCriteria, StoppingCriteriaList
    from qwen_tts import Qwen3TTSModel

    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable. Install a CUDA-enabled PyTorch build or use --device cpu.')
    model = Qwen3TTSModel.from_pretrained(
        args.model_path or args.model, device_map='cuda:0' if args.device == 'cuda' else 'cpu',
        dtype=torch.bfloat16 if args.device == 'cuda' else torch.float32,
        attn_implementation='sdpa',
    )
    cache_key = None
    clone_prompt = None
    model_lock = threading.Lock()
    cancellation_lock = threading.Lock()
    cancellations = OrderedDict()

    def cancellation(request_id):
        with cancellation_lock:
            if request_id not in cancellations:
                cancellations[request_id] = threading.Event()
            cancellations.move_to_end(request_id)
            # Only evict completed cancellation tombstones; active requests
            # retain their event object until generation exits.
            while len(cancellations) > 512:
                cancellations.popitem(last=False)
            return cancellations[request_id]

    class StopOnCancel(StoppingCriteria):
        def __init__(self, event):
            self.event = event

        def __call__(self, input_ids, scores, **kwargs):
            return torch.full((input_ids.shape[0],), self.event.is_set(), device=input_ids.device, dtype=torch.bool)

    # qwen-tts 0.1.1's outer generate() builds a fixed talker_kwargs dict and
    # does not forward arbitrary stopping_criteria. Inject at the HF talker
    # boundary so cancelling really stops generation instead of only its HTTP
    # response. ContextVar keeps each request's cancellation isolated.
    active_cancel = ContextVar('tts_cancel', default=None)
    original_generate = model.model.talker.generate

    def cancellable_generate(*args, **kwargs):
        event = active_cancel.get()
        if event is not None:
            criteria = list(kwargs.get('stopping_criteria') or [])
            kwargs['stopping_criteria'] = StoppingCriteriaList(criteria + [StopOnCancel(event)])
        return original_generate(*args, **kwargs)

    model.model.talker.generate = cancellable_generate

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/health':
                self.respond(200, {'ready': True, 'model': args.model, 'device': args.device})
            else:
                self.respond(404, {'error': 'Unknown endpoint'})

        def do_POST(self):
            nonlocal cache_key, clone_prompt
            if self.path not in ['/v1/audio/speech', '/v1/audio/cancel']:
                self.respond(404, {'error': 'Unknown endpoint'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 128_000:
                    raise ValueError('Invalid request size')
                request = json.loads(self.rfile.read(length))
                request_id = request.get('request_id', '')
                if not isinstance(request_id, str) or len(request_id) > 200:
                    raise ValueError('Invalid request id')
                event = cancellation(request_id) if request_id else threading.Event()
                if self.path == '/v1/audio/cancel':
                    event.set()
                    self.respond(200, {'cancelled': True})
                    return
                if request.get('model') != args.model:
                    raise ValueError('Selected model differs from the running model. Restart the service with --model.')
                if request.get('response_format') != 'pcm':
                    raise ValueError('Only PCM output is supported')
                text = request.get('input', '').strip()
                ref_text = request.get('ref_text', '').strip()
                reference = Path(request.get('ref_audio', '')).expanduser()
                if not text or len(text) > 1000 or not ref_text or not reference.is_absolute() or not reference.is_file():
                    raise ValueError('Provide text, an absolute reference audio path, and its transcript')
                stat = reference.stat()
                if stat.st_size > 50 * 1024 * 1024:
                    raise ValueError('Reference audio exceeds 50 MB')
                key = (str(reference.resolve()), stat.st_mtime_ns, stat.st_size, ref_text)
                with model_lock:
                    if event.is_set():
                        raise ValueError('Request cancelled')
                    if key != cache_key:
                        clone_prompt = model.create_voice_clone_prompt(ref_audio=str(reference), ref_text=ref_text, x_vector_only_mode=False)
                        cache_key = key
                    with torch.inference_mode():
                        context_token = active_cancel.set(event)
                        try:
                            wavs, rate = model.generate_voice_clone(text=text, language='Chinese', voice_clone_prompt=clone_prompt, max_new_tokens=2048)
                        finally:
                            active_cancel.reset(context_token)
                    if event.is_set():
                        raise ValueError('Request cancelled')
                samples = np.asarray(wavs[0], dtype=np.float32)
                if samples.ndim != 1 or not np.isfinite(samples).all():
                    raise ValueError('Model returned invalid audio')
                if rate != 24000:
                    samples = librosa.resample(samples, orig_sr=rate, target_sr=24000)
                if not 0 < len(samples) <= 24000 * 60:
                    raise ValueError('Generated sentence is empty or exceeds 60 seconds')
                pcm = np.rint(np.clip(samples, -1, 1) * np.where(samples < 0, 32768, 32767)).astype('<i2').tobytes()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(pcm)))
                self.send_header('X-Audio-Sample-Rate', '24000')
                self.send_header('X-Audio-Channels', '1')
                self.send_header('X-Audio-Format', 's16le')
                self.end_headers()
                self.wfile.write(pcm)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Caller interrupted; never replay this request.
            except Exception as error:
                print(f'TTS error: {error}', flush=True)
                self.respond(400, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Qwen3-TTS ready at http://127.0.0.1:{args.port}/v1 ({args.device})', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
