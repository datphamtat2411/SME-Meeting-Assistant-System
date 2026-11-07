"""Strict dispatch decoding and a non-administrative, manual-ACK RabbitMQ consumer."""

import asyncio
import ssl
import unicodedata
from typing import Literal
from urllib.parse import unquote, urlsplit

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

    def __init__(self, settings, *, queue_name=None, prefetch=None):
        self.settings = settings
        self.queue_name = queue_name or settings.rabbitmq_queue
        self.prefetch = prefetch or settings.worker_concurrency
        self.connection = self.channel = self.queue = None
        self.tag = None
        self.active = set()
        self.failure = asyncio.Event()
        self._closed = False
        self._accepting = False

    async def __aenter__(self):
        failed = False
        try:
            if not all((self.settings.rabbitmq_url, self.settings.rabbitmq_ca_file)) or not all(
                value is not None and value.get_secret_value().strip()
                for value in (self.settings.rabbitmq_username, self.settings.rabbitmq_password)
            ):
                raise ValueError
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_verify_locations(cafile=str(self.settings.rabbitmq_ca_file))
            endpoint = urlsplit(self.settings.rabbitmq_url)
            # aio-pika's make_url ignores login/password kwargs when URL is set.
            # Build through its keyword form so external credentials really reach
            # the transport, retaining TLS, explicit ports and encoded vhosts.
            async with asyncio.timeout(self.settings.rabbitmq_connect_timeout_seconds):
                self.connection = await aio_pika.connect(
                    host=endpoint.hostname, port=endpoint.port or 5671, ssl=True,
                    virtualhost=unquote(endpoint.path[1:]) if endpoint.path not in ("", "/") else "/",
                    login=self.settings.rabbitmq_username.get_secret_value(),
                    password=self.settings.rabbitmq_password.get_secret_value(), ssl_context=context,
                    timeout=self.settings.rabbitmq_connect_timeout_seconds,
                )
                self.channel = await self.connection.channel()
                await self.channel.set_qos(prefetch_count=self.prefetch)
                self.queue = await self.channel.get_queue(self.queue_name, ensure=True)
        except asyncio.CancelledError:
            await self.__aexit__(None, None, None)
            raise
        except Exception:
            failed = True
        if failed:
            await self.__aexit__(None, None, None)
            raise RuntimeError("worker.messaging.startup.failed")
        return self

    async def start(self, handler):
        async def receive(message):
            if not self._accepting:
                # Cancellation handshake races remain unacknowledged for broker
                # reconciliation; no new claim/inference is admitted locally.
                return
            task = asyncio.create_task(handler(message))
            self.active.add(task)

            def finished(done):
                self.active.discard(done)
                if not done.cancelled() and done.exception() is not None:
                    self.failure.set()

            task.add_done_callback(finished)

        self._accepting = True
        try:
            async with asyncio.timeout(self.settings.rabbitmq_connect_timeout_seconds):
                self.tag = await self.queue.consume(receive, no_ack=False)
        except BaseException:
            self._accepting = False
            raise

    async def stop(self):
        self._accepting = False
        if self.tag is not None and self.channel and not self.channel.is_closed:
            tag, self.tag = self.tag, None
            await self.queue.cancel(tag)

    async def drain(self):
        if self.active:
            await asyncio.gather(*tuple(self.active))

    async def __aexit__(self, *_):
        if self._closed:
            return
        self._closed = True
        try:
            await self.stop()
        finally:
            for task in tuple(self.active):
                task.cancel()
            try:
                if self.active:
                    await asyncio.gather(*tuple(self.active), return_exceptions=True)
            finally:
                if self.connection is not None:
                    await self.connection.close()
