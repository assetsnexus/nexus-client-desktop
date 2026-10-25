#!/usr/bin/env python3
"""
Nexus local speech-to-text server (faster-whisper / CTranslate2).

A tiny, dependency-light HTTP server that runs Whisper on the local machine via
`faster-whisper` (the CTranslate2 runtime), which can use an NVIDIA GPU through
CUDA. The desktop app spawns it in the background for on-device dictation and
wake-word transcription.

Why this exists: upstream whisper.cpp ships CPU-only binaries for Linux, so large
models take tens of seconds per utterance. CTranslate2 on the GPU does the same
work in a few hundred milliseconds — effectively realtime — and supports the same
per-request phrase biasing (agent names) that improves wake accuracy.

TRANSPORT CONTRACT — deliberately identical to whisper.cpp's `/inference`:
  POST <inference-path>
    multipart/form-data
      file              the audio bytes (the app sends 16 kHz mono WAV)
      prompt            optional per-request phrase bias (agent names)
      response_format   ignored (always JSON)
    -> {"text": "<transcript>"}
  GET /health -> {"status": "ok"}

That means the desktop's existing wake/dictation client code talks to either
engine unchanged.

Nothing here leaves the machine: it binds loopback by default and never logs
audio. It is only ever spawned by the app, on the user's own hardware.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# --------------------------------------------------------------------------- #
# Audio decoding
# --------------------------------------------------------------------------- #

def _resample(x, src_rate: int, target_rate: int = 16000):
    """Linear resample to `target_rate`. Cheap and good enough for speech."""
    import numpy as np

    if src_rate == target_rate or len(x) == 0:
        return x
    n = int(round(len(x) * target_rate / src_rate))
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    return np.interp(
        np.linspace(0, len(x) - 1, n), np.arange(len(x)), x
    ).astype(np.float32)


def decode_audio(raw: bytes):
    """
    Decode audio bytes into a float32 mono 16 kHz array.

    The app always sends WAV, so the stdlib `wave` reader covers the hot path
    without any native dependency. Anything else (or a WAV variant `wave`
    rejects) falls back to faster-whisper's PyAV decoder.
    """
    import numpy as np

    try:
        with io.BytesIO(raw) as bio, wave.open(bio, "rb") as w:
            channels = w.getnchannels()
            width = w.getsampwidth()
            rate = w.getframerate()
            frames = w.readframes(w.getnframes())
        if width == 2:
            x = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        elif width == 1:
            x = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif width == 3:
            b = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3)
            i = (
                b[:, 0].astype(np.int32)
                | (b[:, 1].astype(np.int32) << 8)
                | (b[:, 2].astype(np.int8).astype(np.int32) << 16)
            )
            x = i.astype(np.float32) / 8388608.0
        elif width == 4:
            x = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise ValueError(f"unsupported sample width: {width}")
        if channels > 1:
            x = x.reshape(-1, channels).mean(axis=1)
        return _resample(np.ascontiguousarray(x, dtype=np.float32), rate)
    except Exception:
        # Fall back to PyAV for compressed containers / odd WAVs.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from faster_whisper.audio import decode_audio as fw_decode

        path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
                f.write(raw)
                path = f.name
            return np.asarray(fw_decode(path, sampling_rate=16000), dtype=np.float32)
        finally:
            if path and os.path.exists(path):
                os.unlink(path)


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #

class _Engine:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.model = None

    def load(self) -> None:
        from faster_whisper import WhisperModel

        started = time.time()
        # `model` may be an official name (`base`) resolved by faster-whisper, or
        # an absolute CTranslate2 model directory the app downloaded.
        self.model = WhisperModel(
            self.args.model,
            device=self.args.device,
            compute_type=self.args.compute_type,
        )
        # A single machine-readable line so the app can tell "ready" from "still
        # loading" without guessing a sleep duration.
        print(
            f"[local-stt] ready model={self.args.model} device={self.args.device} "
            f"compute_type={self.args.compute_type} load={time.time() - started:.2f}s",
            flush=True,
        )

    def transcribe(self, samples, prompt: str | None) -> str:
        # Phrase bias goes through `hotwords`, NOT `initial_prompt`. An initial
        # prompt is prepended to the decoder's context and leaks into short
        # transcripts (the vocabulary line shows up as the first words spoken);
        # hotwords only re-weight the listed tokens, so agent names are favoured
        # without priming the output. `--initial-prompt` is still accepted as a
        # config default (see `--hotwords`), but the per-request path prefers it.
        hotwords = prompt or self.args.hotwords or None
        segments, _info = self.model.transcribe(
            samples,
            language=self.args.language or None,
            beam_size=self.args.beam_size,
            hotwords=hotwords,
            # No-speech gating is THE defence against whisper's classic
            # hallucination: on silence (or a near-silent room/monitor source) a
            # tiny model confidently emits filler ("ok", "Ok"), single letters
            # ("Q", "F"), or — worse, with hotwords bias — phantom wake names
            # ("Vylaar."), which would then spuriously fire a wake. `no_speech`
            # is ~0.01 for real speech and >0.4 for silence, so the 0.4 gate
            # drops hallucinated segments while leaving real speech untouched.
            # A deterministic temperature (no fallback sampling) and the VAD
            # filter remove the remaining noise-driven loop/stray-token decodes.
            vad_filter=self.args.vad_filter,
            condition_on_previous_text=False,
            no_speech_threshold=self.args.no_speech_threshold,
            log_prob_threshold=self.args.log_prob_threshold,
            temperature=self.args.temperature,
        )
        return "".join(seg.text for seg in segments).strip()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def _multipart_fields(body: bytes, content_type: str) -> dict:
    """Minimal multipart parser: returns name -> bytes for each part."""
    marker = "boundary="
    if marker not in content_type:
        return {}
    boundary = content_type.split(marker, 1)[1].strip().strip('"').encode()
    fields: dict = {}
    for part in body.split(b"--" + boundary):
        if not part or part in (b"--\r\n", b"--\r\n\r\n", b"--"):
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        if not _:
            continue
        # Find the field name in the part headers.
        name = None
        for line in head.split(b"\r\n"):
            if b"content-disposition" in line.lower() and b'name="' in line:
                seg = line.split(b'name="', 1)[1]
                name = seg.split(b'"', 1)[0].decode("utf-8", "ignore")
                break
        if name is None:
            continue
        # Trim the trailing CRLF before the next boundary.
        data = data.rstrip(b"\r\n")
        fields[name] = data
    return fields


class Handler(BaseHTTPRequestHandler):
    engine: _Engine = None  # type: ignore[assignment]
    inference_path: str = "/inference"

    def log_message(self, *_args) -> None:  # silence default request logging
        pass

    def _json(self, status: int, payload: dict) -> None:
        blob = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_GET(self) -> None:  # noqa: N802 (stdlib handler naming)
        if self.path.rstrip("/") in ("/health", ""):
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != self.inference_path.rstrip("/"):
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        fields = _multipart_fields(body, content_type)
        audio = fields.get("file")
        if audio is None:
            # Tolerate a raw-body request (some clients post the bytes directly).
            audio = body or None
        if not audio:
            self._json(400, {"error": "missing audio (multipart field 'file')"})
            return
        prompt = None
        if "prompt" in fields:
            prompt = fields["prompt"].decode("utf-8", "ignore").strip() or None
        try:
            samples = decode_audio(audio)
            text = self.engine.transcribe(samples, prompt)
        except Exception as err:  # never crash the server on one bad request
            self._json(500, {"error": f"{type(err).__name__}: {err}"})
            return
        self._json(200, {"text": text})


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Nexus local STT server (faster-whisper).")
    parser.add_argument("--model", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    # High, clear of 8080-8090 where common dev services (InfluxDB on 8086) live.
    parser.add_argument("--port", type=int, default=18085)
    parser.add_argument("--inference-path", default="/inference")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "auto"])
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--language", default="")
    # Phrase bias for the decoder. Kept as `--hotwords` to match what the app
    # passes; `--initial-prompt` is accepted as an alias for backwards
    # compatibility with older spawns, but both feed the same hotwords path.
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--initial-prompt", dest="hotwords", default="")
    # No-speech / hallucination gating. faster-whisper's own default
    # `no_speech_threshold` is 0.6, which is too permissive for a *wake* path
    # that is biased toward the armed phrases: silence scored 0.46-0.58 and was
    # still decoded into a phantom wake name. `--vad-filter` is accepted as
    # `store_true`/`--no-vad-filter` so a caller can turn it off, but it defaults
    # on (silero VAD drops the silent spans outright).
    parser.add_argument("--no-speech-threshold", type=float, default=0.4)
    parser.add_argument("--log-prob-threshold", type=float, default=-1.0)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true")
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.set_defaults(vad_filter=True)
    args = parser.parse_args(argv)

    engine = _Engine(args)
    engine.load()

    Handler.engine = engine
    Handler.inference_path = args.inference_path
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
