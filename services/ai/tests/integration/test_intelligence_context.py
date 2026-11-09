import asyncio
import hashlib
import json
import os

import httpx
import pytest
from intelligence_support import envelope, settings, stage, task, uid
from unit.test_intelligence_worker import lifecycle

from sme_meeting_ai.meeting_intelligence.composition import prepare_context
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.qualification import fixtures, qualify
from sme_meeting_ai.providers.openrouter_intelligence import (
    OpenRouterIntelligenceAdapter,
)
from sme_meeting_ai.workers.intelligence import IntelligenceWorker


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def test_four_vietnamese_fixtures_deterministic_reference_qualification(caplog):
    conf = settings(meeting_intelligence_inference_enabled=True, OPENROUTER_API_KEY="synthetic-key")
    observed = []
    def provider(r):
        body = json.loads(r.content)
        observed.append(body)
        assert "fabricate" not in body["messages"][0]["content"]
        evidence = json.loads(body["messages"][1]["content"])
        ids = list(dict.fromkeys(unit["segment_id"] for unit in evidence["evidence"]))
        return httpx.Response(200, json=envelope(json.dumps({"segment_ids":ids})))
    with OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(provider)) as adapter:
        report = qualify(adapter, conf)
    assert report.fixture_count == 4 and report.passed == 4
    assert report.live_model_quality_qualified is False
    assert len(observed) == 4
    assert any("ignore" in x["messages"][1]["content"].lower() for x in observed)
    for fixture in fixtures():
        assert fixture["transcript"]["segments"][0]["text"] not in caplog.text


def test_existing_t02_worker_can_inject_context_consumer_without_lifecycle_changes():
    async def run():
        worker_settings, core, storage, delivery, candidate = lifecycle()
        context = stage()
        owned = await core.claim(None)
        transcript = context.snapshot["transcript"]
        transcript.update(id=owned.source.transcriptId, meetingId=owned.meetingId,
                          sourceMediaId=owned.sourceMediaId)
        raw = json.dumps(context.snapshot, ensure_ascii=False).encode()
        owned = owned.model_copy(update={"source": owned.source.model_copy(update={
            "sizeBytes":len(raw), "sha256":hashlib.sha256(raw).hexdigest()})})
        core.state = "AVAILABLE"
        async def claim(*args, **kwargs):
            core.state = "RUNNING"
            return owned
        core.claim = claim
        storage.get_intelligence_snapshot = lambda *args: raw
        conf = settings(meeting_intelligence_inference_enabled=True, OPENROUTER_API_KEY="synthetic-key")
        seen = []
        adapter = OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json=envelope())))
        def processor(stage_context):
            prepared = prepare_context(stage_context, task(), conf)
            response = prepared.execute(adapter, 0)
            for sid in response.output["segment_ids"]:
                assert prepared.plan.source.resolve(sid).segment_id == sid
            seen.append(response)
            # Only a controlled test result: no production feature algorithm/registration.
            return candidate
        worker = IntelligenceWorker(worker_settings, core, storage, {"GENERATING_SUMMARY":processor})
        try:
            await worker.handle(delivery)
            assert delivery.acked and core.accepts == 1 and core.failures == 0 and len(seen) == 1
            assert seen[0].source.sha256 == owned.source.sha256
        finally:
            await worker.aclose()
            adapter.close()
    asyncio.run(run())


def test_only_selected_window_is_transmitted_and_model_ids_stay_configured():
    from intelligence_support import snapshot
    conf = settings(meeting_intelligence_inference_enabled=True, OPENROUTER_API_KEY="synthetic-key",
                    meeting_intelligence_model="vendor/explicit", meeting_intelligence_max_input_tokens=4000,
                    meeting_intelligence_overlap_units=0)
    prepared = prepare_context(stage(snapshot(tuple(f"Part {i} " * 120 for i in range(5)))), task(), conf)
    assert len(prepared.plan.windows) > 1
    selected = prepared.plan.windows[0]
    def provider(r):
        body = json.loads(r.content)
        assert body["model"] == "vendor/explicit"
        assert uid(104) not in body["messages"][1]["content"]
        return httpx.Response(200, json=envelope(json.dumps({"segment_ids":list(selected.segment_ids)})))
    with OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(provider)) as adapter:
        response = prepared.execute(adapter, 0)
    assert response.requested_model == "vendor/explicit"


def test_lease_loss_closes_real_inflight_http_connection():
    """Loopback-only transport verifies actual socket cleanup, not paid inference."""
    async def run():
        started, peer_closed = asyncio.Event(), asyncio.Event()
        async def serve(reader, writer):
            try:
                header = await reader.readuntil(b"\r\n\r\n")
                length = next(int(line.split(b":", 1)[1]) for line in header.split(b"\r\n")
                              if line.lower().startswith(b"content-length:"))
                await reader.readexactly(length)
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n")
                await writer.drain()
                started.set()
                await reader.read()
                peer_closed.set()
            finally:
                writer.close()
                await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        class LoopbackTransport(httpx.AsyncBaseTransport):
            def __init__(self): self.inner = httpx.AsyncHTTPTransport()
            async def handle_async_request(self, request):
                request.url = httpx.URL(f"http://127.0.0.1:{port}/chat/completions")
                return await self.inner.handle_async_request(request)
            async def aclose(self): await self.inner.aclose()
        conf = settings(meeting_intelligence_inference_enabled=True, OPENROUTER_API_KEY="synthetic-key")
        context = stage()
        prepared = prepare_context(context, task(), conf)
        with OpenRouterIntelligenceAdapter(conf, transport=LoopbackTransport()) as adapter:
            pending = asyncio.create_task(asyncio.to_thread(prepared.execute, adapter, 0))
            try:
                await asyncio.wait_for(started.wait(), 2)
                context.cancelled.set()
                with pytest.raises(IntelligenceError, match="CANCELLED"):
                    await asyncio.wait_for(pending, 2)
                await asyncio.wait_for(peer_closed.wait(), 2)
            finally:
                context.cancelled.set()
                await asyncio.gather(pending, return_exceptions=True)
                server.close()
                await server.wait_closed()
    asyncio.run(run())
