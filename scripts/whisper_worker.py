"""Persistent local Whisper worker. stdin/stdout are JSON lines, never audio files."""
import argparse
import json
import sys
import time


def reply(value):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()
    try:
        import numpy as np
        from faster_whisper import WhisperModel
        from opencc import OpenCC

        converter = OpenCC("t2s")
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                             cpu_threads=4, num_workers=1, local_files_only=True)
        # Exercise inference before reporting ready (CUDA DLLs can be lazy-loaded).
        warmup, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="zh",
                                    beam_size=1, condition_on_previous_text=False, vad_filter=False)
        list(warmup)
        reply({"ready": True, "device": args.device, "model": args.model})
    except Exception as error:
        reply({"error": str(error)})
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            samples = request["samples"]
            if not 1600 <= len(samples) <= 400000:
                raise ValueError("Expected 0.1–25 seconds of mono 16kHz PCM")
            audio = np.asarray(samples, dtype=np.float32) / 32768.0
            if not np.isfinite(audio).all():
                raise ValueError("Invalid audio samples")
            started = time.perf_counter()
            # No expected script/lyrics prompt: copying that prompt could falsely
            # suggest that words were heard. Retain music for future lyric tests.
            segments, _ = model.transcribe(
                audio, language="zh", beam_size=1, temperature=0,
                condition_on_previous_text=False, word_timestamps=True,
                vad_filter=False, no_speech_threshold=0.6,
                hallucination_silence_threshold=1.0,
            )
            output = []
            for segment in segments:
                if segment.no_speech_prob > 0.6 or segment.avg_logprob < -1.0:
                    continue
                output.append({
                    "text": converter.convert(segment.text.strip()),
                    "start_ms": round(segment.start * 1000),
                    "end_ms": round(segment.end * 1000),
                    "words": [{"text": converter.convert(word.word),
                               "start_ms": round(word.start * 1000),
                               "end_ms": round(word.end * 1000),
                               "probability": round(word.probability, 4)}
                              for word in (segment.words or [])],
                })
            reply({"segments": output, "inference_ms": round((time.perf_counter() - started) * 1000)})
        except Exception as error:
            reply({"error": str(error)})


if __name__ == "__main__":
    main()
