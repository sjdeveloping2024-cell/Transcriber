"""Lilt — a tiny local web server for the voice-to-text interface.

The Faster-Whisper command-line transcriber lives separately in
``whisper_transcriber.py`` so the web app and the terminal tool can be used
independently.
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import time
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
LOCAL_MODEL_DIR = PROJECT_ROOT / "backend" / "models" / "vosk-model-small-en-us-0.15"
LOCAL_SAMPLE_RATE = 16000
LOCAL_SESSION_TTL = 15 * 60

app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path="",
)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

_local_model = None
_local_model_error = None
_local_model_lock = threading.Lock()
_local_sessions = {}
_local_sessions_lock = threading.Lock()


class LocalSession:
    """One in-progress on-device transcription, fed 16 kHz mono PCM."""

    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.lock = threading.Lock()
        self.updated = time.monotonic()

    def feed(self, audio: bytes):
        with self.lock:
            self.updated = time.monotonic()
            final_text = ""

            if self.recognizer.AcceptWaveform(audio):
                final_text = json.loads(self.recognizer.Result()).get("text", "").strip()

            partial_text = json.loads(self.recognizer.PartialResult()).get("partial", "").strip()
            return final_text, partial_text

    def finish(self) -> str:
        with self.lock:
            return json.loads(self.recognizer.FinalResult()).get("text", "").strip()


def get_local_model():
    """Load the offline speech model once, on first use."""
    global _local_model, _local_model_error

    if _local_model is not None:
        return _local_model

    with _local_model_lock:
        if _local_model is not None:
            return _local_model

        if _local_model_error is not None:
            raise RuntimeError(_local_model_error)

        try:
            from vosk import Model, SetLogLevel
        except ImportError:
            _local_model_error = (
                "The on-device speech engine isn’t installed. Install Vosk, then restart the server."
            )
            raise RuntimeError(_local_model_error) from None

        if not LOCAL_MODEL_DIR.is_dir():
            _local_model_error = (
                "The on-device speech model is missing. Reinstall the app files and try again."
            )
            raise RuntimeError(_local_model_error) from None

        SetLogLevel(-1)

        try:
            _local_model = Model(str(LOCAL_MODEL_DIR))
        except Exception:
            _local_model_error = "The on-device speech model couldn’t be loaded."
            raise RuntimeError(_local_model_error) from None

        return _local_model


def create_local_session() -> LocalSession:
    from vosk import KaldiRecognizer

    model = get_local_model()
    return LocalSession(KaldiRecognizer(model, LOCAL_SAMPLE_RATE))


def purge_stale_sessions() -> None:
    now = time.monotonic()
    with _local_sessions_lock:
        stale = [
            session_id
            for session_id, session in _local_sessions.items()
            if now - session.updated > LOCAL_SESSION_TTL
        ]
        for session_id in stale:
            _local_sessions.pop(session_id, None)


def get_local_session(session_id: str):
    with _local_sessions_lock:
        return _local_sessions.get(session_id)


@app.after_request
def add_response_headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "microphone=(self)"
    return response


@app.errorhandler(413)
def request_too_large(error):
    return jsonify(error="That audio chunk was too large."), 413


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok", app="lilt")


@app.get("/api/local/status")
def local_status():
    try:
        get_local_model()
    except RuntimeError as error:
        return jsonify(available=False, reason=str(error)), 503

    return jsonify(
        available=True,
        engine="vosk",
        model="vosk-model-small-en-us-0.15",
        languages=["en-US"],
        sample_rate=LOCAL_SAMPLE_RATE,
    )


@app.post("/api/local/start")
def local_start():
    purge_stale_sessions()

    try:
        session = create_local_session()
    except RuntimeError as error:
        return jsonify(available=False, reason=str(error)), 503
    except Exception:
        return jsonify(available=False, reason="The on-device engine couldn’t start."), 500

    session_id = uuid.uuid4().hex

    with _local_sessions_lock:
        _local_sessions[session_id] = session

    return jsonify(id=session_id, sample_rate=LOCAL_SAMPLE_RATE)


@app.post("/api/local/<session_id>/audio")
def local_audio(session_id: str):
    session = get_local_session(session_id)
    if session is None:
        return jsonify(error="That recording session has ended."), 404

    audio = request.get_data(cache=False)
    if not audio or len(audio) % 2:
        return jsonify(error="Expected 16-bit PCM audio."), 400

    try:
        final_text, partial_text = session.feed(audio)
    except Exception:
        with _local_sessions_lock:
            _local_sessions.pop(session_id, None)
        return jsonify(error="The on-device engine couldn’t read that audio."), 500

    return jsonify(final=final_text, partial=partial_text)


@app.post("/api/local/<session_id>/finish")
def local_finish(session_id: str):
    with _local_sessions_lock:
        session = _local_sessions.pop(session_id, None)

    if session is None:
        return jsonify(error="That recording session has ended."), 404

    try:
        text = session.finish()
    except Exception:
        return jsonify(error="The on-device engine couldn’t finish this recording."), 500

    return jsonify(text=text)


@app.post("/api/local/<session_id>/cancel")
def local_cancel(session_id: str):
    with _local_sessions_lock:
        _local_sessions.pop(session_id, None)
    return ("", 204)


def port_is_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Lilt transcription app.")
    parser.add_argument(
        "--port",
        type=int,
        default=5000,
        help="Port to listen on (default: 5000).",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don’t open the browser automatically.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.port < 1 or args.port > 65535:
        print("\n  Choose a port between 1 and 65535.\n")
        raise SystemExit(1)

    if not port_is_available(args.port):
        next_port = args.port + 1 if args.port < 65535 else 5000
        print(f"\n  Port {args.port} is already in use.")
        print(f"  Try: python backend/Transcriber.py --port {next_port}\n")
        raise SystemExit(1)

    print("\n  Lilt - voice to text")
    print(f"  Running at http://127.0.0.1:{args.port}")
    print("  Press Ctrl+C to stop.\n")

    if not args.no_browser:
        threading.Timer(
            0.75,
            webbrowser.open,
            args=(f"http://127.0.0.1:{args.port}",),
        ).start()

    try:
        app.run(
            host="127.0.0.1",
            port=args.port,
            debug=False,
            use_reloader=False,
            threaded=True,
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
