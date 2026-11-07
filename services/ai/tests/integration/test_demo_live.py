"""Explicitly opted-in paid HTTP smoke test. Never uses implicit corpus fixtures."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from sme_meeting_ai.core.config import load_settings


@pytest.mark.live_provider
def test_live_demo_upload_to_two_speaker_result():
    if os.getenv("AI_RUN_DEMO_LIVE") != "1":
        pytest.skip("Set AI_RUN_DEMO_LIVE=1 and provide permitted audio to opt in")
    path = os.getenv("AI_DEMO_LIVE_AUDIO")
    if not path or not Path(path).is_file():
        pytest.skip("AI_DEMO_LIVE_AUDIO must identify a permitted short Vietnamese two-speaker recording")
    selected = load_settings()
    if not (selected.openrouter_api_key and selected.replicate_api_token
            and selected.transcript_correction_model and selected.audio_vad_model_path
            and selected.audio_vad_model_path.is_file()):
        pytest.skip("Configure OpenRouter, correction model, Replicate and real Silero VAD first")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "AI_DEMO_ENABLED": "true", "AI_ENVIRONMENT": "development",
           "AI_HTTP_HOST": "127.0.0.1", "AI_HTTP_PORT": str(port)}
    process = subprocess.Popen([sys.executable, "-m", "sme_meeting_ai.api"], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=30) as http:
            startup_deadline = time.monotonic() + 60
            while True:
                assert process.poll() is None, "Demo HTTP startup failed"
                try:
                    if http.get("/health/ready").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                assert time.monotonic() < startup_deadline, "Demo startup timed out"
                time.sleep(0.25)
            with Path(path).open("rb") as audio:
                accepted = http.post("/demo/v1/jobs", files={"file": ("audio.wav", audio)})
            assert accepted.status_code == 202
            job_id = accepted.json()["jobId"]
            deadline = time.monotonic() + 1800
            while True:
                response = http.get(f"/demo/v1/jobs/{job_id}")
                assert response.status_code == 200
                job = response.json()
                if job["status"] in ("completed", "failed"):
                    break
                assert time.monotonic() < deadline, "Live smoke observation deadline exceeded"
                time.sleep(2)
            assert job["status"] == "completed", "Live transcription/correction did not complete"
            result = job["result"]
            valid_text = bool(result["segments"]) and all(s["text"].strip() for s in result["segments"])
            assert valid_text, "No valid corrected transcript was returned"
            assert result["diarization"]["status"] == "completed", "Live diarization did not complete"
            speaker_count = len(result["diarization"]["speakers"])
            assert speaker_count >= 2, "Two-speaker attribution was not established"
            labels = {s["label"] for s in result["diarization"]["speakers"]}
            assert all(s["speakerLabel"] is None or s["speakerLabel"] in labels for s in result["segments"])
            print(f"Live demo completed: {len(result['segments'])} corrected segments, "
                  f"{len(result['diarization']['speakers'])} anonymous clusters")
    finally:
        process.terminate()
        try:
            process.wait(timeout=selected.http_shutdown_timeout_seconds + 5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
