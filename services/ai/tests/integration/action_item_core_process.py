"""Invoked by the Java T06 acceptance test: real mTLS Core and TLS RabbitMQ.

Only source storage and LLM inference are controlled. No canonical HTTP success,
ownership, sink, receipt, delivery status, or RabbitMQ acknowledgments are mocked.
"""

import asyncio
import json
import ssl
import sys

import aio_pika
from intelligence_support import settings
from unit.test_decision import ScriptedAdapter, _identity

from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.intelligence import (
    QUEUE,
    IntelligenceCoreClient,
    decode_notification,
)
from sme_meeting_ai.integrations.messaging import RabbitConsumer
from sme_meeting_ai.meeting_intelligence.action_items import ActionItemProcessor
from sme_meeting_ai.workers.intelligence import IntelligenceWorker


async def run(config):
    pki = config["pki"]
    conf = settings(core_api_base_url=config["coreUrl"], core_api_server_ca_file=pki + "/ca.crt",
        core_api_client_cert_file=pki + "/mi.crt", core_api_client_key_file=pki + "/mi.key",
        rabbitmq_url=config["brokerUrl"],
        rabbitmq_ca_file=pki + "/ca.crt", rabbitmq_username="t06", rabbitmq_password="isolated-t06-password",
        meeting_intelligence_worker_execution_timeout_seconds=60)

    class Core(IntelligenceCoreClient):
        accepts = 0

        async def accept_action_items(self, *args, **kwargs):
            self.accepts += 1
            receipt = await super().accept_action_items(*args, **kwargs)
            if config["mode"] == "lost":
                # Discard the actual committed response before the coordinator sees it.
                raise CoreError()
            return receipt

    core = Core(conf, acceptance_token="A" * 43)

    class Storage:
        def get_intelligence_snapshot(self, source, fence):
            return config["snapshot"].encode("utf-8")

    def infer(request):
        assert request.task.schema.name == "action_window_signals"
        unit = json.loads(request.window.evidence_json)["evidence"][0]
        signals = [] if config["mode"] == "empty" else [dict(action="kiểm tra lỗi đăng nhập",
            deliverable="lỗi đăng nhập", signal_type="ASSIGNED", mentioned_party="Minh",
            deadline_expression="", qualification="", uncertainty="NONE", requires_context=False,
            evidence=[{k: unit[k] for k in ("segment_id", "char_start", "char_end")}])]
        return {**_identity(request), "signals": signals}

    adapter = ScriptedAdapter(infer)
    processors = {"EXTRACTING_ACTION_ITEMS": ActionItemProcessor(conf, adapter)}
    worker = IntelligenceWorker(conf, core, Storage(), processors)
    acked, redelivered = [], []
    done = asyncio.Queue()

    class ObservedDelivery:
        def __init__(self, message):
            self.message = message

        def __getattr__(self, name):
            return getattr(self.message, name)

        async def ack(self):
            status = await core.lookup(decode_notification(self))
            assert status.state == "RESULT_ACCEPTED" and status.durable
            await self.message.ack()
            acked.append(status.state)
            redelivered.append(self.message.redelivered)

    async def handle(message):
        try:
            await worker.handle(ObservedDelivery(message))
            await done.put(None)
        except BaseException as error:
            await done.put(error)

    context = ssl.create_default_context(cafile=pki + "/ca.crt")
    admin = await aio_pika.connect(host="localhost", port=config["brokerPort"], ssl=True,
        ssl_context=context, login="t06", password="isolated-t06-password")
    try:
        channel = await admin.channel()
        exchange = await channel.declare_exchange("meeting.processing", aio_pika.ExchangeType.TOPIC, durable=True)
        queue = await channel.declare_queue(QUEUE, durable=True, arguments={"x-queue-type": "quorum"})
        await queue.bind(exchange, "processing.intelligence.requested")
        event = config["event"]

        async def publish():
            await exchange.publish(aio_pika.Message(json.dumps(event).encode(), content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT, message_id=event["eventId"],
                headers=dict(eventId=event["eventId"], eventType="PROCESSING_INTELLIGENCE_STAGE_REQUESTED",
                             eventSchemaVersion=1)), "processing.intelligence.requested", mandatory=True)

        async with RabbitConsumer(conf, queue_name=QUEUE, prefetch=1) as broker:
            await publish()
            await broker.start(handle)
            error = await asyncio.wait_for(done.get(), 45)
            if error:
                raise error
            assert len(acked) == 1 and len(adapter.requests) == 1 and core.accepts == 1
            await broker.stop()
            await broker.drain()
            # Fresh coordinator process state and a real broker redelivery. The
            # accepted canonical receipt must prevent any inference or submission.
            await worker.aclose()
            worker = IntelligenceWorker(conf, core, Storage(), {})
            await publish()
            replay = await queue.get(timeout=10)
            await replay.nack(requeue=True)
            await broker.start(handle)
            error = await asyncio.wait_for(done.get(), 30)
            if error:
                raise error
            assert len(acked) == 2 and redelivered[-1]
            assert len(adapter.requests) == 1 and core.accepts == 1
            await broker.stop()
            await broker.drain()
        assert await queue.get(fail=False, timeout=5) is None
        return dict(acknowledged=len(acked), modelCalls=len(adapter.requests), accepts=core.accepts,
                    redelivery=redelivered[-1], state="RESULT_ACCEPTED")
    finally:
        await worker.aclose()
        await core.aclose()
        await admin.close()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run(json.load(sys.stdin)))))
