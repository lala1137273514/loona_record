from __future__ import annotations

import io
import json
import unittest
import wave

import numpy as np

from python_wake_service.server import (
    decode_wav_pcm16,
    extract_wav_body,
    iter_frames,
    read_http_body,
)


def make_wav(samples: np.ndarray, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples.astype("<i2").tobytes())
    return buf.getvalue()


class FakeBodyHandler:
    def __init__(self, raw: bytes, headers: dict[str, str]) -> None:
        self.rfile = io.BytesIO(raw)
        self.headers = headers


class ServerHelpersTest(unittest.TestCase):
    def test_decode_wav_pcm16_accepts_expected_format(self) -> None:
        samples = np.array([0, 32767, -32768, 7], dtype=np.int16)

        decoded = decode_wav_pcm16(make_wav(samples))

        np.testing.assert_array_equal(decoded, samples)

    def test_decode_wav_pcm16_rejects_wrong_sample_rate(self) -> None:
        with self.assertRaisesRegex(ValueError, "expected 16000 Hz"):
            decode_wav_pcm16(make_wav(np.zeros(160, dtype=np.int16), sample_rate=8000))

    def test_iter_frames_uses_session_frame_offset(self) -> None:
        pcm = np.arange(320, dtype=np.int16)

        frames = list(iter_frames(pcm, start_index=42))

        self.assertEqual([frame.index for frame in frames], [42, 43])
        np.testing.assert_array_equal(frames[0].pcm, pcm[:160])
        np.testing.assert_array_equal(frames[1].pcm, pcm[160:320])

    def test_read_http_body_supports_content_length(self) -> None:
        handler = FakeBodyHandler(b"abc", {"content-length": "3"})

        self.assertEqual(read_http_body(handler), b"abc")

    def test_read_http_body_supports_chunked_transfer(self) -> None:
        raw = b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"
        handler = FakeBodyHandler(raw, {"transfer-encoding": "chunked"})

        self.assertEqual(read_http_body(handler), b"abcde")

    def test_extract_wav_body_accepts_base64_json(self) -> None:
        wav_body = make_wav(np.zeros(160, dtype=np.int16))
        body = json.dumps({
            "audio_wav_base64": __import__("base64").b64encode(wav_body).decode("ascii"),
        }).encode("utf-8")

        self.assertEqual(extract_wav_body(body, "application/json"), wav_body)

    def test_extract_wav_body_keeps_raw_wav(self) -> None:
        wav_body = make_wav(np.zeros(160, dtype=np.int16))

        self.assertEqual(extract_wav_body(wav_body, "audio/wav"), wav_body)


if __name__ == "__main__":
    unittest.main()
