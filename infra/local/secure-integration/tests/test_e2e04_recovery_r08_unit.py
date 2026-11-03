"""R08 source checkpoint retains the active source until the owner exits."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

import test_worker_e2e04 as e2e  # noqa: F401
from e2e04_recovery_faults import SOURCE_OPEN, checkpoint_source


def test_source_checkpoint_holds_real_context_until_parent_release(tmp_path):
    path = tmp_path / "source.media"
    path.write_bytes(b"synthetic source")
    exited = []

    @contextmanager
    def source():
        try:
            yield path
        finally:
            exited.append(True)

    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()

        class Control:
            async def checkpoint(self, name, **fields):
                assert name == SOURCE_OPEN
                entered.set()
                await asyncio.wait_for(release.wait(), 1)

        loop = asyncio.get_running_loop()

        def reader():
            with checkpoint_source(source(), Control(), loop, event_id="event-a") as active:
                assert active == path and path.exists() and not exited

        task = asyncio.create_task(asyncio.to_thread(reader))
        await asyncio.wait_for(entered.wait(), 1)
        assert path.exists() and not exited and not task.done()
        release.set()
        await asyncio.wait_for(task, 1)
        assert exited == [True]

    asyncio.run(exercise())


def test_source_checkpoint_cleans_context_on_control_failure(tmp_path):
    class Control:
        async def checkpoint(self, *args, **kwargs):
            raise RuntimeError("bounded control failed")

    async def exercise():
        exited = []

        @contextmanager
        def source():
            try:
                yield SimpleNamespace()
            finally:
                exited.append(True)

        def reader():
            with checkpoint_source(source(), Control(), loop, event_id="event-a"):
                raise AssertionError("must not execute")

        loop = asyncio.get_running_loop()
        import pytest

        with pytest.raises(RuntimeError, match="bounded control failed"):
            await asyncio.wait_for(asyncio.to_thread(reader), 1)
        assert exited == [True]

    asyncio.run(exercise())
