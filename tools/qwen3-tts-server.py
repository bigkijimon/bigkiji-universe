#!/usr/bin/env python3
"""Local-only Qwen3-TTS bridge for BigKiji Universe.

The HTTP surface intentionally binds to 127.0.0.1 and exposes only health and
synthesis. Model loading is asynchronous so Electron startup is never blocked.
"""

import argparse
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"state": "loading", "ready": False, "detail": "Importing Qwen3-TTS", "model": None}
MODEL = None
MODEL_LOCK = threading.Lock()


def load_model(model_name):
    global MODEL
    STATE.update(model=model_name, detail=f"Loading {model_name}")
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        devices = ["mps", "cpu"] if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else ["cpu"]
        errors = []
        for device in devices:
            try:
                STATE.update(state="loading", ready=False, detail=f"Loading {model_name} on {device}")
                MODEL = Qwen3TTSModel.from_pretrained(model_name, device_map=device, dtype=torch.float32)
                STATE.update(state="ready", ready=True, detail=f"{model_name} on {device}", device=device)
                return
            except Exception as exc:
                MODEL = None
                errors.append(f"{device}: {type(exc).__name__}: {exc}")
                STATE.update(state="loading", ready=False, detail=f"{device} unavailable; trying fallback")
        raise RuntimeError(" | ".join(errors))
    except Exception as exc:  # Health remains available and Electron falls back safely.
        STATE.update(state="unavailable", ready=False, detail=f"{type(exc).__name__}: {exc}")


class Handler(BaseHTTPRequestHandler):
    server_version = "BigKijiQwenTTS/1.0"

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(200, STATE)

    def do_POST(self):
        if self.path != "/synthesize":
            self.send_json(404, {"error": "not found"})
            return
        if not STATE["ready"] or MODEL is None:
            self.send_json(503, STATE)
            return
        try:
            size = min(int(self.headers.get("Content-Length", "0")), 65536)
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            text = str(payload.get("text", "")).strip()[:1200]
            if not text:
                raise ValueError("text is empty")
            with MODEL_LOCK:
                wavs, sample_rate = MODEL.generate_custom_voice(
                    text=text,
                    language=payload.get("language") or "English",
                    speaker=payload.get("speaker") or "Aiden",
                    instruct=payload.get("instruct") or "",
                )
            import soundfile as sf
            output = io.BytesIO()
            sf.write(output, wavs[0], sample_rate, format="WAV", subtype="PCM_16")
            body = output.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self.send_json(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17890)
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    args = parser.parse_args()
    threading.Thread(target=load_model, args=(args.model,), daemon=True).start()
    print(f"Qwen3-TTS bridge listening on http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
