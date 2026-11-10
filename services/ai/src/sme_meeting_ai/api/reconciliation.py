"""Authenticated, read-only Qdrant inspection for Core reconciliation."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from sme_meeting_ai.rag.qdrant import QdrantError

from .security import require_internal_operation

RECONCILIATION_OPERATION = "knowledge.reconciliation"
RECONCILIATION_PATH = "/internal/v1/knowledge-indexing/reconciliation"
MAX_REQUEST_BYTES = 256 * 1024


class SourceIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    sourceType: Literal["TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM"]
    sourceId: UUID
    meetingId: UUID


class SourceRevision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    number: int = Field(ge=0, strict=True)


class SourceAuditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    sourceIdentity: SourceIdentity
    sourceRevision: SourceRevision


class ReconciliationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    contractVersion: Literal["1.0"]
    generationId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    requests: tuple[SourceAuditRequest, ...] = Field(min_length=1, max_length=500)


router = APIRouter(prefix="/internal/v1/knowledge-indexing")


@router.post(
    "/reconciliation",
    dependencies=[Depends(require_internal_operation(RECONCILIATION_OPERATION))],
)
async def reconciliation(request: Request) -> JSONResponse:
    content_length = request.headers.get("content-length")
    if content_length is not None and (not content_length.isdecimal() or int(content_length) > MAX_REQUEST_BYTES):
        raise HTTPException(413)
    raw = await request.body()
    if len(raw) > MAX_REQUEST_BYTES:
        raise HTTPException(413)
    try:
        payload = ReconciliationRequest.model_validate_json(raw)
    except Exception:
        raise HTTPException(422) from None

    store = getattr(request.app.state, "knowledge_vector_store", None)
    if store is None:
        raise HTTPException(503)
    if payload.generationId != store.spec.compatibility.index_generation_id:
        raise HTTPException(409)
    try:
        store.validate_retrieval_schema()
        records = [
            {
                "sourceIdentity": {
                    "sourceType": item.sourceIdentity.sourceType,
                    "sourceId": str(item.sourceIdentity.sourceId),
                    "meetingId": str(item.sourceIdentity.meetingId),
                },
                "sourceRevision": {"number": item.sourceRevision.number},
                "pointCount": store.count_source_points(
                    str(item.sourceIdentity.meetingId), item.sourceIdentity.sourceType,
                    str(item.sourceIdentity.sourceId), item.sourceRevision.number, payload.generationId,
                ),
            }
            for item in payload.requests
        ]
    except QdrantError:
        raise HTTPException(503) from None
    return JSONResponse(
        {"contractVersion": "1.0", "generationId": payload.generationId, "records": records},
        headers={"Cache-Control": "no-store"},
    )


__all__ = ["RECONCILIATION_OPERATION", "RECONCILIATION_PATH", "router"]
