"""API and Linux lifecycle tests. No ML dependencies or GPU needed."""
import importlib.util
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


api = module("speech_server")
worker = module("funasr_worker")


class SpeechTest(unittest.TestCase):
    def test_tts_does_not_read_json_metadata_or_punctuation_as_an_answer(self):
        for text in ['{"emotion": "playful",', '"speech": "你好",', '"gesture": "none",', '}', '...', '<think>分析问题</think>']:
            with self.assertRaises(ValueError):
                api.spoken_text(text)
        self.assertEqual(api.spoken_text(' 小宇，这是姐姐的小秘密呀。 '), '小宇，这是姐姐的小秘密呀。')

    def test_invalid_waveforms_are_not_silently_converted_into_pcm(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("requires numpy; run with the TTS venv interpreter")
        for wave in [np.array([]), np.array([0, np.nan]), np.array([np.inf]), np.zeros(24000 * 60 + 1)]:
            with self.assertRaises(api.InvalidWaveform):
                api.encode_pcm(wave)
        self.assertEqual(api.encode_pcm(np.array([-1., 0., 1.])), b'\x01\x80\x00\x00\xff\x7f')

    def test_windows_unicode_audio_paths_map_into_wsl(self):
        self.assertEqual(str(api.local_path("\u202aG:\\声音\\菜菜.wav")), "/mnt/g/声音/菜菜.wav")
        self.assertEqual(str(api.local_path(' \u202a"G:\\声音\\菜菜.wav"\u202c ')), "/mnt/g/声音/菜菜.wav")
        self.assertEqual(str(api.local_path("/mnt/g/reference.wav")), "/mnt/g/reference.wav")
        with self.assertRaises(ValueError):
            api.local_path("relative.wav")
        with self.assertRaises(ValueError):
            api.local_path("\\\\server\\share\\file.wav")

    def test_cancel_reaches_all_active_sentences_and_is_bounded(self):
        service = api.SpeechService(Path("/tmp"), SCRIPTS)
        a, b = threading.Event(), threading.Event()
        service.active["reply"] = [a, b]
        service.cancel("reply")
        self.assertTrue(a.is_set() and b.is_set())
        self.assertIn("reply", service.cancelled)
        for i in range(1000):
            service.cancel(str(i))
        self.assertEqual(len(service.cancelled), 256)
        self.assertFalse(service.health()["acceleration"]["verified"])

    def test_funasr_timestamps_are_milliseconds_and_empty_audio_is_empty(self):
        result = worker.normalize({"text": "你好。", "sentence_info": [{"text": "你好。", "start": 100, "end": 800}]}, 1000)
        self.assertEqual(result["segments"], [{"start_ms": 100, "end_ms": 800, "text": "你好。"}])
        self.assertEqual(worker.normalize({}, 1000)["segments"], [])
        fallback = worker.normalize({"text": "你好", "timestamp": [[100, 200], [200, 400]]}, 1000)
        self.assertEqual(fallback["segments"][0]["end_ms"], 400)

    def test_http_contract_uses_new_routes_and_exact_pcm_headers(self):
        service = api.SpeechService(Path("/tmp"), SCRIPTS)
        service.ready = True
        service.tts = lambda _: b"\x01\x00" * 10
        class ASR:
            def transcribe(self, body):
                return {"text": "中文", "segments": [{"start_ms": 0, "end_ms": 100, "text": "中文"}]}
        service.asr = ASR()
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        server.service = service
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        def request(path, body):
            return urllib.request.urlopen(urllib.request.Request(url + path, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=2)
        try:
            with request("/api/stt", {"audio": "test"}) as response:
                self.assertEqual(json.load(response)["text"], "中文")
            with request("/api/tts", {"input": "中文"}) as response:
                self.assertEqual(response.headers["X-Audio-Sample-Rate"], "24000")
                self.assertEqual(response.headers["X-Audio-Channels"], "1")
                self.assertEqual(response.headers["X-Audio-Format"], "s16le")
                self.assertEqual(response.read(), b"\x01\x00" * 10)
            with self.assertRaises(urllib.error.HTTPError) as old:
                request("/v1/audio/speech", {})
            self.assertEqual(old.exception.code, 404)
            service.ready = False
            with self.assertRaises(urllib.error.HTTPError) as loading:
                request("/api/tts", {})
            self.assertEqual(loading.exception.code, 503)
            with request("/api/tts/cancel", {"request_id": "reply"}) as response:
                self.assertTrue(json.load(response)["cancelled"])
            self.assertIn("reply", service.cancelled)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    @unittest.skipUnless(sys.platform == "linux", "Linux process identity and WSL lifecycle")
    def test_stop_during_loading_kills_owned_process_group_and_preserves_other_process(self):
        control = module("speech_control")
        with tempfile.TemporaryDirectory(prefix="speech-control-test-") as folder:
            root = Path(folder)
            (root / "tts/bin").mkdir(parents=True)
            (root / "tts/bin/python").symlink_to(sys.executable)
            # Fake a long model load, without opening a port.
            (root / "speech_server.py").write_text("import time; time.sleep(120)\n")
            args = [sys.executable, str(SCRIPTS / "speech_control.py")]
            params = ["--root", str(root), "--scripts", str(root)]
            launcher = subprocess.Popen(args + ["run"] + params)
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
            try:
                pidfile = root / "service.pid.json"
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(pidfile.exists())
                saved = json.loads(pidfile.read_text())
                subprocess.run(args + ["stop"] + params, check=True, timeout=20)
                launcher.wait(timeout=5)
                self.assertIsNone(control.identity(saved["pid"]))
                self.assertIsNone(unrelated.poll())
                # An obsolete pidfile pointing at a live unrelated pid cannot authorize a kill.
                saved["pid"] = unrelated.pid
                pidfile.write_text(json.dumps(saved))
                subprocess.run(args + ["stop"] + params, check=True, timeout=2)
                self.assertIsNone(unrelated.poll())
            finally:
                if launcher.poll() is None:
                    subprocess.run(args + ["stop"] + params, timeout=20)
                    launcher.kill()
                    launcher.wait()
                unrelated.terminate()
                unrelated.wait()


if __name__ == "__main__":
    unittest.main()
