"""Strict dispatch decoding and a non-administrative, manual-ACK RabbitMQ consumer."""

import asyncio
import ssl
import unicodedata
from typing import Literal

import aio_pika
from pydantic import Field, ValidationError, field_validator

from .core_api import Count, StageCode, Timestamp, Uuid, WireModel, strict_json


class MessageError(Exception):
    def __init__(self):
        super().__init__("WORKER_MESSAGE_INVALID")


class QueuedEvent(WireModel):
    eventId: Uuid
    processingJobId: Uuid
    meetingId: Uuid
    sourceMediaId: Uuid
    requestedByUserId: Uuid
    requestId: str = Field(min_length=1, max_length=128)
    schemaVersion: Literal[1]
    occurredAt: Timestamp

    @field_validator("requestId")
    @classmethod
    def correlation_id(cls, value):
        if not value.strip() or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("Invalid correlation ID")
        return value

    @property
    def generation(self):
        return 0

    @property
    def event_type(self):
        return "PROCESSING_JOB_QUEUED"


class RetryEvent(QueuedEvent):
    schemaVersion: Literal[2]
    retryFromStage: StageCode | None
    attemptNumber: Count = Field(ge=1)

    @property
    def generation(self):
        return self.attemptNumber

    @property
    def event_type(self):
        return "PROCESSING_JOB_RETRY_REQUESTED"


def decode_event(body, *, headers, message_id, content_type, delivery_mode):
    try:
        if content_type != "application/json" or delivery_mode != 2:
            raise ValueError
        data = strict_json(body, 16384)
        if not isinstance(data, dict) or type(data.get("schemaVersion")) is not int:
            raise ValueError
        version = data["schemaVersion"]
        if version not in (1, 2):
            raise ValueError
        event = (QueuedEvent if version == 1 else RetryEvent).model_validate(data)
        if (message_id != event.eventId or headers.get("eventId") != event.eventId
                or headers.get("eventType") != event.event_type):
            raise ValueError
        return event
    except (ValueError, TypeError, AttributeError, RecursionError, ValidationError):
        pass
    raise MessageError()


class RabbitConsumer:
    """No queue declarations/migration, publisher rights or automatic ACK contexts."""

    def __init__(self, settings):
        self.settings = settings
        self.connection = self.channel = self.queue = None
        self.tag = None
        self.active = set()
        self.failure = asyncio.Event()

    async def __aenter__(self):
        failed = False
        try:
            if not all((self.settings.rabbitmq_url, self.settings.rabbitmq_username,
                        self.settings.rabbitmq_password, self.settings.rabbitmq_ca_file)):
                raise ValueError
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_verify_locations(cafile=str(self.settings.rabbitmq_ca_file))
            self.connection = await aio_pika.connect(
                self.settings.rabbitmq_url, login=self.settings.rabbitmq_username.get_secret_value(),
                password=self.settings.rabbitmq_password.get_secret_value(), ssl_context=context,
                timeout=self.settings.rabbitmq_connect_timeout_seconds,
            )
            self.channel = await self.connection.channel()
            await self.channel.set_qos(prefetch_count=self.settings.worker_concurrency)
            self.queue = await self.channel.get_queue(self.settings.rabbitmq_queue, ensure=True)
        except Exception:
            failed = True
        if failed:
            await self.__aexit__(None, None, None)
            raise RuntimeError("worker.messaging.startup.failed")
        return self

    async def start(self, handler):
        async def receive(message):
            task = asyncio.create_task(handler(message))
            self.active.add(task)

            def finished(done):
                self.active.discard(done)
                if not done.cancelled() and done.exception() is not None:
                    self.failure.set()

            task.add_done_callback(finished)

        self.tag = await self.queue.consume(receive, no_ack=False)

    async def stop(self):
        if self.tag is not None and self.channel and not self.channel.is_closed:
            tag, self.tag = self.tag, None
            await self.queue.cancel(tag)

    async def drain(self):
        if self.active:
            await asyncio.gather(*tuple(self.active))

    async def __aexit__(self, *_):
        try:
            await self.stop()
        finally:
            for task in tuple(self.active):
                task.cancel()
            if self.active:
                await asyncio.gather(*tuple(self.active), return_exceptions=True)
            if self.connection is not None:
                await self.connection.close()
