import asyncio
import threading
from pathlib import Path
from unittest.mock import Mock

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.demo.jobs import DemoCapacityError, DemoJobManager
from sme_meeting_ai.demo.models import DemoDiarization, DemoResult, SpeakerHints
from sme_meeting_ai.demo.pipeline import DemoProcessingError


def config(tmp_path, **kwargs):
    return Settings(_env_file=None, service_name="test", service_identity="ai-core",
                    audio_temp_dir=tmp_path, **kwargs)


def result():
    return DemoResult(durationMs=100, language="vi", segments=(),
                      diarization=DemoDiarization(status="skipped"))


async def until(predicate):
    async def wait():
        while not predicate():
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), timeout=5)


def upload(manager, reservation=None):
    reservation = manager.reserve() if reservation is None else reservation
    temporary = manager.new_upload()
    path = Path(temporary.name) / "audio.wav"
    path.write_bytes(b"private-audio")
    accepted = manager.submit(reservation, path, temporary, SpeakerHints())
    return accepted.jobId, path


def test_bounded_states_off_loop_queue_rejection_and_completion_cleanup(tmp_path):
    async def run():
        entered, release = threading.Event(), threading.Event()
        main_thread = threading.get_ident()
        active = []

        def execute(path, *, hints, on_stage, deadline):
            assert threading.get_ident() != main_thread
            assert path.exists() and deadline > 0
            active.append(path)
            on_stage("transcription")
            entered.set()
            assert release.wait(5)
            on_stage("diarization")
            return result()

        runner = Mock(run=execute)
        manager = DemoJobManager(config(tmp_path, demo_max_queued_jobs=1), runner)
        manager.start()
        try:
            first, first_path = upload(manager)
            await until(entered.is_set)
            assert manager.get(first).stage == "transcription"
            second, second_path = upload(manager)
            assert manager.get(second).status == "queued"
            with pytest.raises(DemoCapacityError):
                manager.reserve()
            assert len(active) == 1
            release.set()
            await until(lambda: manager.get(second).status == "completed")
            for job_id, path in ((first, first_path), (second, second_path)):
                snapshot = manager.get(job_id)
                assert snapshot.status == snapshot.stage == "completed"
                assert snapshot.result == result() and snapshot.error is None
                assert not path.exists()
            assert manager.get(first) is not manager.get(first)
        finally:
            release.set()
            await manager.aclose()
        runner.close.assert_called_once()
        assert list(tmp_path.iterdir()) == []
    asyncio.run(run())


@pytest.mark.parametrize("error,code", [
    (RuntimeError("secret-provider-body"), "PROCESSING_FAILED"),
    (DemoProcessingError("TIMEOUT"), "TIMEOUT"),
])
def test_failure_cleanup_and_sanitization(tmp_path, error, code):
    async def run():
        runner = Mock()
        runner.run.side_effect = error
        manager = DemoJobManager(config(tmp_path), runner)
        manager.start()
        try:
            job_id, path = upload(manager)
            await until(lambda: manager.get(job_id).status == "failed")
            snapshot = manager.get(job_id)
            assert snapshot.stage == "transcription" and snapshot.result is None
            assert snapshot.error.code == code
            assert "secret-provider-body" not in snapshot.model_dump_json()
            assert not path.exists()
        finally:
            await manager.aclose()
    asyncio.run(run())


def test_reservations_expiry_and_terminal_count_are_bounded(tmp_path):
    async def run():
        clock = Mock(return_value=0.0)
        runner = Mock()
        runner.run.return_value = result()
        manager = DemoJobManager(config(tmp_path, demo_max_retained_jobs=1, demo_result_ttl_seconds=1),
                                 runner, clock=clock, cleanup_interval_seconds=0.01)
        manager.start()
        try:
            reservation = manager.reserve()
            manager.release(reservation)
            manager.release(reservation)
            first, _ = upload(manager)
            await until(lambda: manager.get(first).status == "completed")
            second, _ = upload(manager)
            await until(lambda: manager.get(second).status == "completed")
            assert manager.get(first) is None
            assert manager.get(second) is not None
            clock.return_value = 2.0
            # Let the periodic reaper run; do not trigger lazy expiry through get().
            await until(lambda: not manager._jobs)
            assert manager.get(second) is None
        finally:
            await manager.aclose()
    asyncio.run(run())


def test_shutdown_cancels_queued_but_retains_active_resources_until_real_completion(tmp_path):
    async def run():
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()

        def execute(path, **kwargs):
            entered.set()
            assert release.wait(5)
            assert path.exists() and not closed.is_set()
            return result()

        runner = Mock(run=execute, close=closed.set)
        manager = DemoJobManager(config(tmp_path, http_shutdown_timeout_seconds=0.01), runner)
        manager.start()
        first, first_path = upload(manager)
        await until(entered.is_set)
        _, second_path = upload(manager)
        try:
            await manager.aclose()
            assert first_path.exists() and not second_path.exists()
            assert not closed.is_set()
            with pytest.raises(DemoCapacityError):
                manager.reserve()
        finally:
            release.set()
        await until(closed.is_set)
        await until(lambda: not first_path.exists())
        await until(lambda: not list(tmp_path.iterdir()))
        assert manager.get(first) is None
        assert list(tmp_path.iterdir()) == []
    asyncio.run(run())


def test_submission_after_shutdown_cleans_rejected_upload(tmp_path):
    async def run():
        manager = DemoJobManager(config(tmp_path), Mock())
        manager.start()
        reservation = manager.reserve()
        temporary = manager.new_upload()
        path = Path(temporary.name) / "audio.wav"
        path.write_bytes(b"audio")
        await manager.aclose()
        with pytest.raises(DemoCapacityError):
            manager.submit(reservation, path, temporary, SpeakerHints())
        assert not path.exists()
    asyncio.run(run())
