"""Strict parsing for the Replicate model's JSON file, never embeddings."""

import json
import math
import re

from .models import DiarizationError, DiarizationErrorCategory, DiarizationResult, SpeakerTurn

MAX_OUTPUT_BYTES = 8 * 1024 * 1024
_MAX_SEGMENTS = 100_000
_MAX_SPEAKERS = 1000
_TIME = re.compile(r"([0-9]{1,6}):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?\Z")
_LABEL = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\Z")


def parse_timestamp(value: object) -> int:
    """Round nonnegative timestamp to nearest millisecond, half up."""
    if not isinstance(value, str) or not (match := _TIME.fullmatch(value)):
        raise ValueError("Invalid timestamp")
    hours, minutes, seconds = map(int, match.group(1, 2, 3))
    fractional = (match.group(4) or "").ljust(9, "0")
    nanoseconds = int(fractional)
    return ((hours * 3600 + minutes * 60 + seconds) * 1000
            + (nanoseconds + 500_000) // 1_000_000)


def _unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError
    return number


def parse_output(data: bytes, model_id: str) -> DiarizationResult:
    try:
        return _parse(data, model_id)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError, DiarizationError):
        pass
    raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)


def _parse(data: bytes, model_id: str) -> DiarizationResult:
    if not isinstance(data, bytes) or len(data) > MAX_OUTPUT_BYTES:
        raise ValueError
    obj = json.loads(data, object_pairs_hook=_unique, parse_constant=_invalid_constant, parse_float=_finite_float)
    if not isinstance(obj, dict) or not isinstance(obj.get("segments"), list):
        raise ValueError
    segments = obj["segments"]
    metadata = obj.get("speakers")
    if len(segments) > _MAX_SEGMENTS or not isinstance(metadata, dict):
        raise ValueError
    labels = metadata.get("labels")
    count = metadata.get("count")
    if (not isinstance(labels, list) or len(labels) > _MAX_SPEAKERS
            or type(count) is not int or count != len(labels)
            or any(not isinstance(label, str) or not _LABEL.fullmatch(label) for label in labels)
            or len(set(labels)) != len(labels)):
        raise ValueError
    raw = []
    for item in segments:
        if not isinstance(item, dict):
            raise ValueError
        label = item["speaker"]
        if not isinstance(label, str) or label not in labels:
            raise ValueError
        start, end = parse_timestamp(item["start"]), parse_timestamp(item["stop"])
        if start >= end:
            raise ValueError
        raw.append((start, label, end))
    if set(labels) != {label for _, label, _ in raw}:
        raise ValueError
    raw.sort()
    mapping = {}
    turns = []
    for start, label, end in raw:
        if label not in mapping:
            mapping[label] = f"SPEAKER_{len(mapping):02d}"
        turns.append(SpeakerTurn(start, end, mapping[label]))
    return DiarizationResult(tuple(turns), tuple(mapping.values()), model_id)
