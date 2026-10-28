"""Own one WSL service process group; never terminate the WSL distribution."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def identity(pid):
    try:
        # comm may contain spaces or parentheses. starttime is field 22.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": fields[19], "cmd": Path(f"/proc/{pid}/cmdline").read_bytes().hex()}
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned(path):
    try:
        value = json.loads(path.read_text())
        return value if value == identity(value["pid"]) else None
    except (OSError, ValueError, KeyError):
        return None


def stop(path):
    value = owned(path)
    if not value:
        return
    os.killpg(value["pid"], signal.SIGTERM)
    deadline = time.monotonic() + 12
    while owned(path) and time.monotonic() < deadline:
        time.sleep(0.1)
    if owned(path):
        os.killpg(value["pid"], signal.SIGKILL)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["run", "stop", "status"])
    p.add_argument("--root", required=True)
    p.add_argument("--scripts", required=True)
    a = p.parse_args()
    root = Path(a.root)
    pidfile = root / "service.pid.json"
    if not root.is_dir():
        raise RuntimeError("WSL speech runtime missing; run npm run setup:speech")
    # run and stop serialize the spawn+pidfile transaction, including model loading.
    with (root / "control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if a.action == "status":
            print(json.dumps({"running": bool(owned(pidfile))}))
            return
        if a.action == "stop":
            stop(pidfile)
            return
        if owned(pidfile):
            raise RuntimeError("Speech service already running")
        env = dict(os.environ, CUDA_HOME="/usr/local/cuda-12.8")
        env["PATH"] = str(root / "tts/bin") + ":/usr/local/cuda-12.8/bin:" + env.get("PATH", "")
        env["LD_LIBRARY_PATH"] = "/usr/lib/wsl/lib:/usr/local/cuda-12.8/lib64:" + env.get("LD_LIBRARY_PATH", "")
        env["HF_HUB_OFFLINE"] = "1"
        child = subprocess.Popen([str(root / "tts/bin/python"), "-u", str(Path(a.scripts) / "speech_server.py"),
                                  "--root", str(root), "--scripts", a.scripts], start_new_session=True, env=env)
        pidfile.write_text(json.dumps(identity(child.pid)))
    # Signals to the launcher must clean up Linux descendants too.
    def terminate(*_):
        stop(pidfile)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        sys.exit(child.wait())
    finally:
        with (root / "control.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if pidfile.exists() and json.loads(pidfile.read_text()).get("pid") == child.pid:
                pidfile.unlink()


if __name__ == "__main__":
    main()
