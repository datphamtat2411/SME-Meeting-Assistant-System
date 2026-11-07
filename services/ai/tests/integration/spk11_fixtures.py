"""Synthetic, permitted SPK-11 evidence and offline vendor-transport controls."""

import asyncio
import io
import json
import math
import struct
import wave
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from sme_meeting_ai.providers import replicate_diarization
from sme_meeting_ai.providers.replicate_diarization import ReplicateDiarizationAdapter

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures/diarization-smoke.json").read_text())


def synthetic_wav():
    """Two tones, not voices; labels test orchestration, not inference accuracy."""
    rate = FIXTURE["sampleRate"]
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(b"".join(struct.pack("<h", int(4000 * math.sin(
            2 * math.pi * (220 if i < rate else 440) * i / rate)))
            for i in range(rate * FIXTURE["durationMs"] // 1000)))
    return output.getvalue()


class FakeInference:
    """The real adapter parses these responses; no provider sockets are opened."""

    def __init__(self, mode="two", checkpoint=lambda _: None):
        self.mode, self.checkpoint = mode, checkpoint
        self.calls = []
        self.backoffs = []

    async def __call__(self, request):
        host, path = request.url.host, request.url.path
        assert host in ("api.replicate.com", "replicate.delivery"), "Unexpected inference destination"
        self.calls.append((request.method, path))
        if path == "/v1/files":
            self.checkpoint("inference")
            if self.mode == "auth":
                return httpx.Response(401, text="SECRET provider diagnostics must never escape")
            if self.mode == "timeout":
                await asyncio.Event().wait()  # The adapter's own bounded deadline cancels this.
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/synthetic"}})
        if path == "/v1/predictions":
            attempts = sum(p == path for _, p in self.calls)
            if self.mode == "rate-persistent" or self.mode == "rate-transient" and attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "2"}, text="SECRET rate diagnostic")
            return httpx.Response(201, json={"status": "succeeded", "output": "https://replicate.delivery/result"})
        assert host == "replicate.delivery" and path == "/result"
        scenario = FIXTURE["scenarios"].get(self.mode, FIXTURE["scenarios"]["two"])

        def timestamp(ms):
            return f"0:00:{ms / 1000:09.6f}"

        return httpx.Response(200, json={
            "segments": [{"start": timestamp(a), "stop": timestamp(b), "speaker": label}
                         for a, b, label in scenario["turns"]],
            "speakers": {"count": len(scenario["labels"]), "labels": scenario["labels"]},
        })

    async def sleep(self, seconds):
        self.backoffs.append(seconds)


@contextmanager
def controlled_adapter(settings, fake):
    # Replace only the provider module's clock-wait seam. Worker lease and HTTP
    # deadlines retain the real event loop. Bounded backoff values remain asserted.
    clock = SimpleNamespace(**{name: getattr(asyncio, name) for name in (
        "get_running_loop", "timeout_at", "run")}, sleep=fake.sleep)
    with patch.object(replicate_diarization, "asyncio", clock):
        yield ReplicateDiarizationAdapter(settings, transport=httpx.MockTransport(fake))
