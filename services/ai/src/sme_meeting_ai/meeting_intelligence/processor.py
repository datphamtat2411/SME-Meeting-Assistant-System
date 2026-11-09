"""Capability boundary: processors never receive broker or ownership credentials."""

from dataclasses import dataclass, field
from threading import Event
from typing import Callable, Protocol


@dataclass(frozen=True)
class StageContext:
    processing_job_id: str
    stage_run_id: str
    stage_code: str
    meeting_id: str
    source_snapshot_id: str
    source_sha256: str
    transcript_id: str
    content_revision: int
    snapshot: dict = field(repr=False)
    deadline: float
    cancelled: Event = field(repr=False)


class StageProcessor(Protocol):
    def __call__(self, context: StageContext) -> dict: ...


ProcessorRegistry = dict[str, Callable[[StageContext], dict]]
