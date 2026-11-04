import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers import replicate_diarization
from sme_meeting_ai.providers.replicate_diarization import ReplicateDiarizationAdapter


@pytest.mark.live_provider
def test_live_replicate_diarization(monkeypatch):
    if os.environ.get("AI_RUN_REPLICATE_LIVE") != "1":
        pytest.skip("Set AI_RUN_REPLICATE_LIVE=1 to opt in")
    audio_path = os.environ.get("AI_DIARIZATION_LIVE_AUDIO")
    if not audio_path or not Path(audio_path).is_file():
        pytest.skip("Set AI_DIARIZATION_LIVE_AUDIO to an existing permitted two-speaker audio file")
    settings = Settings(service_name="live-test", service_identity="ai-core")
    if not settings.replicate_api_token or not settings.replicate_api_token.get_secret_value().strip():
        pytest.skip("Configure REPLICATE_API_TOKEN in the environment or .env")

    parse = replicate_diarization.parse_output

    def inspect_structure(data, model_id):
        # Report only expected field names and types, never provider values or labels.
        try:
            obj = json.loads(data)
            segments = obj.get("segments") if isinstance(obj, dict) else None
            speakers = obj.get("speakers") if isinstance(obj, dict) else None
            first = segments[0] if isinstance(segments, list) and segments else None
            fields = {key: type(first.get(key)).__name__ for key in ("speaker", "start", "stop")} if (
                isinstance(first, dict)
            ) else None
            metadata = {key: type(speakers.get(key)).__name__ for key in ("count", "labels")} if (
                isinstance(speakers, dict)
            ) else None
            print(f"Output structure: root={type(obj).__name__}, segments={type(segments).__name__}, "
                  f"segment fields={fields}, speakers={type(speakers).__name__}, speaker fields={metadata}")
        except (ValueError, TypeError, RecursionError):
            print("Output structure: invalid JSON")
        return parse(data, model_id)

    monkeypatch.setattr(replicate_diarization, "parse_output", inspect_structure)

    original_request = replicate_diarization._json_request

    async def trace_request(client, method, url, **kwargs):
        if url.endswith("/v1/files"):
            stage = "upload"
        elif url.endswith("/v1/predictions"):
            stage = "create_prediction"
        else:
            stage = "poll_prediction"

        print(f"[Replicate] {stage}: START", flush=True)
        response = await original_request(client, method, url, **kwargs)
        if stage == "upload":
            urls = response.get("urls", {})
            value = urls.get("get") if isinstance(urls, dict) else None
            parts = urlsplit(value) if isinstance(value, str) else None
            print("[Replicate] upload URL diagnostics:", {
                "type": type(value).__name__,
                "length": len(value) if isinstance(value, str) else None,
                "scheme": parts.scheme if parts else None,
                "hostname": parts.hostname if parts else None,
                "path_length": len(parts.path) if parts else None,
                "api_file_prefix": parts.path.startswith("/v1/files/") if parts else None,
                "matches_current_regex": (
                    bool(re.fullmatch(r"/v1/files/[a-zA-Z0-9_-]{1,128}", parts.path)) if parts else None
                ),
                "has_query": bool(parts.query) if parts else None,
                "has_fragment": bool(parts.fragment) if parts else None,
            }, flush=True)
        print(
            f"[Replicate] {stage}: "
            f"keys={sorted(response.keys())}, "
            f"status={response.get('status')}, "
            f"output_type={type(response.get('output')).__name__}, "
            f"urls_type={type(response.get('urls')).__name__}",
            flush=True,
        )
        return response

    monkeypatch.setattr(replicate_diarization, "_json_request", trace_request)
    result = ReplicateDiarizationAdapter(settings).diarize(Path(audio_path))
    assert result.turns
    assert all(turn.speaker_label in result.speakers for turn in result.turns)
    print(f"Normalized output: {len(result.turns)} turns, {len(result.speakers)} speakers")
    assert len(result.speakers) >= 2, "Two-speaker fixture did not produce at least two speaker clusters"


def test_live_configuration_loads_dotenv(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    monkeypatch.setenv("AI_RUN_REPLICATE_LIVE", "1")
    audio = tmp_path / "fixture.wav"
    audio.write_bytes(b"test")
    monkeypatch.setenv("AI_DIARIZATION_LIVE_AUDIO", str(audio))
    (tmp_path / ".env").write_text("REPLICATE_API_TOKEN=dotenv-test-token\n")
    observed = []

    class FakeAdapter:
        def __init__(self, settings):
            observed.append(settings.replicate_api_token.get_secret_value())

        def diarize(self, path):
            assert path == audio
            return SimpleNamespace(turns=[SimpleNamespace(speaker_label="SPEAKER_00")],
                                   speakers=("SPEAKER_00", "SPEAKER_01"))

    monkeypatch.setattr(__import__(__name__, fromlist=["ReplicateDiarizationAdapter"]),
                        "ReplicateDiarizationAdapter", FakeAdapter)
    test_live_replicate_diarization(monkeypatch)
    assert observed == ["dotenv-test-token"]


@pytest.mark.parametrize("missing", ["opt_in", "audio", "token"])
def test_live_configuration_skips_when_required_input_missing(tmp_path, monkeypatch, missing):
    monkeypatch.chdir(tmp_path)
    audio = tmp_path / "fixture.wav"
    audio.write_bytes(b"test")
    monkeypatch.setenv("AI_RUN_REPLICATE_LIVE", "1" if missing != "opt_in" else "0")
    monkeypatch.setenv("AI_DIARIZATION_LIVE_AUDIO", str(audio) if missing != "audio" else "")
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    if missing != "token":
        monkeypatch.setenv("REPLICATE_API_TOKEN", "test-token")
    with pytest.raises(pytest.skip.Exception):
        test_live_replicate_diarization(monkeypatch)
