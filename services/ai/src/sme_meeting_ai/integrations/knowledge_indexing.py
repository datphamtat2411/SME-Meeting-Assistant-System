"""Versioned notification boundary for Core-owned knowledge indexing work.

Notifications are references, not proof of authority. A worker must still claim
the exact revision and obtain its canonical snapshot from Core before indexing.
"""

from typing import Literal

from pydantic import Field, ValidationError

from sme_meeting_ai.rag.contracts import IndexLifecycleEvent

from .core_api import strict_json
from .messaging import MessageError

QUEUE = "meeting.knowledge.indexing"
ROUTE = "knowledge.indexing.requested"
EXCHANGE = "meeting.processing"
EVENT_TYPE = "KNOWLEDGE_INDEXING_REQUESTED"
MAX_EVENT_BYTES = 16384


class KnowledgeIndexingEvent(IndexLifecycleEvent):
    """T01 lifecycle event plus the transport version and trace correlation."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    request_id: str = Field(alias="requestId", pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def decode_notification(delivery) -> KnowledgeIndexingEvent:
    """Decode one persistent, explicitly routed UPSERT without exposing input."""

    try:
        if (delivery.content_type != "application/json" or delivery.delivery_mode != 2
                or delivery.routing_key != ROUTE or delivery.exchange != EXCHANGE):
            raise ValueError
        data = strict_json(delivery.body, MAX_EVENT_BYTES)
        if not isinstance(data, dict) or type(data.get("schemaVersion")) is not int:
            raise ValueError
        event = KnowledgeIndexingEvent.model_validate(data)
        headers = delivery.headers
        version, count = headers.get("eventSchemaVersion"), headers.get("x-delivery-count", 0)
        if (event.operation != "UPSERT" or type(version) is not int or version != event.schema_version
                or headers.get("eventId") != event.event_id or delivery.message_id != event.event_id
                or headers.get("eventType") != EVENT_TYPE or type(count) is not int or count < 0
                or delivery.redelivered and "x-delivery-count" not in headers):
            raise ValueError
        return event
    except (ValueError, TypeError, AttributeError, RecursionError, ValidationError):
        pass
    raise MessageError()
