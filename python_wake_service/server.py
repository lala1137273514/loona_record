"""HTTP sidecar for the original TorchKWS + SegmentVerifier pipeline.

The Next.js app sends small 16 kHz mono PCM16 WAV chunks with a stable
session id. This service keeps the original Python KWS/VAD/Pipeline state per
session, so VAD boundaries and refractory timing behave like the old lab app.
"""

from __future__ import annotations

import argparse
import hmac
import io
import json
import os
import time
import wave
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import numpy as np

from .loona_wake import FRAME_SIZE, SAMPLE_RATE
from .loona_wake.audio import Frame
from .loona_wake.kws import SegmentVerifier, TorchKWS
from .loona_wake.pipeline import Pipeline, PipelineOutput
from .loona_wake.vad import EnergyVAD

DEFAULT_KWS_THRESHOLD = 0.50
DEFAULT_VERIFIER_THRESHOLD = 0.3
DEFAULT_HOP_MS = 80
DEFAULT_CONSEC = 1
DEFAULT_SESSION_TTL_SEC = 15 * 60


def decode_wav_pcm16(body: bytes) -> np.ndarray:
    """Decode a 16 kHz mono PCM16 WAV body into int16 PCM samples."""
    with wave.open(io.BytesIO(body), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        compression = wav.getcomptype()
        if channels != 1:
            raise ValueError(f"expected mono WAV, got {channels} channels")
        if sample_width != 2:
            raise ValueError(f"expected PCM16 WAV, got sample width {sample_width}")
        if sample_rate != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE} Hz WAV, got {sample_rate} Hz")
        if compression != "NONE":
            raise ValueError(f"expected uncompressed WAV, got {compression}")
        frames = wav.readframes(wav.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.int16, copy=True)


def iter_frames(pcm: np.ndarray, start_index: int) -> Iterator[Frame]:
    """Yield 10 ms frames with monotonically increasing session frame indexes."""
    n_frames = len(pcm) // FRAME_SIZE
    for offset in range(n_frames):
        start = offset * FRAME_SIZE
        yield Frame(index=start_index + offset, pcm=pcm[start : start + FRAME_SIZE])


def extract_wake_token(headers: Any) -> str | None:
    direct = headers.get("x-loona-wake-token")
    if direct:
        return direct

    authorization = headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def is_valid_wake_token(provided: str | None, expected: str | None) -> bool:
    if not expected:
        return True
    if not provided:
        return False
    return hmac.compare_digest(provided, expected)


class ScoredVerifier:
    """Wrap SegmentVerifier so the HTTP response can expose the score."""

    def __init__(self, model_path: Path, threshold: float) -> None:
        self._verifier = SegmentVerifier(str(model_path), threshold=threshold)
        self.threshold = self._verifier.threshold
        self.last_score = 0.0

    def accept(self, pcm16: np.ndarray) -> bool:
        self.last_score = self._verifier.score(pcm16)
        return self.last_score >= self.threshold


@dataclass
class DetectorSession:
    kws: TorchKWS
    pipeline: Pipeline
    verifier: ScoredVerifier | None
    next_frame_index: int = 0
    last_seen: float = field(default_factory=time.time)
    lock: Lock = field(default_factory=Lock)


class WakeDetector:
    """Session manager around the original Loona Python detector."""

    def __init__(
        self,
        model_dir: Path,
        *,
        session_ttl_sec: int = DEFAULT_SESSION_TTL_SEC,
        kws_threshold: float = DEFAULT_KWS_THRESHOLD,
        verifier_threshold: float = DEFAULT_VERIFIER_THRESHOLD,
    ) -> None:
        self.model_dir = model_dir
        self.kws_model = model_dir / "loona_kws.pt"
        self.verifier_model = model_dir / "loona_verifier.pt"
        self.session_ttl_sec = session_ttl_sec
        self.kws_threshold = kws_threshold
        self.verifier_threshold = verifier_threshold
        self._sessions: dict[str, DetectorSession] = {}
        self._sessions_lock = Lock()
        if not self.kws_model.exists():
            raise FileNotFoundError(f"missing KWS model: {self.kws_model}")

    def reset(self, session_id: str) -> bool:
        with self._sessions_lock:
            return self._sessions.pop(session_id, None) is not None

    def feed_wav(self, session_id: str, body: bytes) -> dict[str, Any]:
        pcm = decode_wav_pcm16(body)
        full_frames = len(pcm) // FRAME_SIZE
        if full_frames == 0:
            return {
                "wake": False,
                "events": [],
                "checked_ms": 0,
                "session_id": session_id,
                "detector": "torchkws+verifier",
            }

        session = self._get_session(session_id)
        events: list[dict[str, Any]] = []
        with session.lock:
            for frame in iter_frames(pcm, session.next_frame_index):
                for output in session.pipeline.feed(frame):
                    if output.responded:
                        events.append(self._serialize_output(output, session))
            session.next_frame_index += full_frames
            session.last_seen = time.time()
            latest_kws_score = float(session.kws.last_score)

        response: dict[str, Any] = {
            "wake": bool(events),
            "events": events,
            "checked_ms": full_frames * 10,
            "session_id": session_id,
            "detector": "torchkws+verifier",
            "kws_score": latest_kws_score,
        }
        if events:
            response.update(events[-1])
        return response

    def _get_session(self, session_id: str) -> DetectorSession:
        self._prune_sessions()
        with self._sessions_lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = self._create_session()
                self._sessions[session_id] = session
            return session

    def _create_session(self) -> DetectorSession:
        kws = TorchKWS(
            str(self.kws_model),
            threshold=self.kws_threshold,
            hop_ms=DEFAULT_HOP_MS,
            consec=DEFAULT_CONSEC,
        )
        verifier = (
            ScoredVerifier(self.verifier_model, self.verifier_threshold)
            if self.verifier_model.exists()
            else None
        )
        front_vad = self._create_front_vad()
        pipeline = Pipeline(front_vad, kws, auto_followup=False, verifier=verifier)
        return DetectorSession(kws=kws, pipeline=pipeline, verifier=verifier)

    def _create_front_vad(self) -> Any:
        try:
            from .loona_wake.vad import SileroVAD

            return SileroVAD(0.2)
        except Exception as exc:  # noqa: BLE001 - optional runtime dependency
            print(f"Silero VAD unavailable, using EnergyVAD: {exc}")
            return EnergyVAD()

    def _serialize_output(self, output: PipelineOutput, session: DetectorSession) -> dict[str, Any]:
        utterance = output.utterance
        return {
            "wake": True,
            "position": utterance.wake_position,
            "duration_ms": utterance.duration_ms,
            "score": float(utterance.kws_hit.score if utterance.kws_hit else 0.0),
            "verifier_score": (
                float(session.verifier.last_score) if session.verifier is not None else None
            ),
            "responded": output.responded,
            "reason": utterance.reason,
        }

    def _prune_sessions(self) -> None:
        now = time.time()
        with self._sessions_lock:
            expired = [
                session_id
                for session_id, session in self._sessions.items()
                if now - session.last_seen > self.session_ttl_sec
            ]
            for session_id in expired:
                self._sessions.pop(session_id, None)


class WakeRequestHandler(BaseHTTPRequestHandler):
    detector: WakeDetector
    wake_api_token: str | None = None

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[wake] {self.address_string()} {fmt % args}")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(HTTPStatus.OK, {"ok": True, "detector": "torchkws+verifier"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in {"/wake", "/wake/reset"} and not self._is_authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"wake": False, "error": "unauthorized"})
            return

        params = parse_qs(parsed.query)
        session_id = (
            params.get("session_id", [None])[0]
            or self.headers.get("x-loona-session-id")
            or "default"
        )
        if parsed.path == "/wake/reset":
            removed = self.detector.reset(session_id)
            self._json(HTTPStatus.OK, {"ok": True, "removed": removed, "session_id": session_id})
            return
        if parsed.path != "/wake":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            result = self.detector.feed_wav(session_id, body)
            self._json(HTTPStatus.OK, result)
        except Exception as exc:  # noqa: BLE001 - keep service alive and report the real issue
            self._json(HTTPStatus.BAD_REQUEST, {"wake": False, "error": str(exc)})

    def _json(self, status: HTTPStatus, obj: dict[str, Any]) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "authorization,content-type,x-loona-session-id,x-loona-wake-token",
        )

    def _is_authorized(self) -> bool:
        return is_valid_wake_token(extract_wake_token(self.headers), self.wake_api_token)


def build_handler(
    detector: WakeDetector,
    wake_api_token: str | None = None,
) -> type[WakeRequestHandler]:
    class Handler(WakeRequestHandler):
        pass

    Handler.detector = detector
    Handler.wake_api_token = wake_api_token
    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Loona TorchKWS HTTP sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--model-dir", type=Path, default=Path(__file__).with_name("models"))
    parser.add_argument("--session-ttl-sec", type=int, default=DEFAULT_SESSION_TTL_SEC)
    parser.add_argument("--wake-api-token", default=os.environ.get("WAKE_API_TOKEN"))
    args = parser.parse_args()

    detector = WakeDetector(args.model_dir, session_ttl_sec=args.session_ttl_sec)
    server = ThreadingHTTPServer(
        (args.host, args.port),
        build_handler(detector, wake_api_token=args.wake_api_token or None),
    )
    print(f"Loona wake sidecar listening on http://{args.host}:{args.port}")
    print(f"Models: {args.model_dir}")
    print(f"Wake API token required: {bool(args.wake_api_token)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Loona wake sidecar")


if __name__ == "__main__":
    main()
