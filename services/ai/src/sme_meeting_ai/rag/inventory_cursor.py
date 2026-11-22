"""Strict cursor contract for the Qdrant inventory boundary."""

from __future__ import annotations

import re
from uuid import UUID

MAX_INVENTORY_CURSOR_LENGTH = 36
MAX_UNSIGNED_POINT_ID = (1 << 64) - 1

_ASCII_DECIMAL = re.compile(r"[0-9]+")
_UUID_HEX = re.compile(r"[0-9a-fA-F]{32}")
_UUID_HYPHENATED = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


class InvalidInventoryCursor(ValueError):
    """Invalid caller-supplied or provider-generated inventory cursor."""


def _invalid() -> InvalidInventoryCursor:
    return InvalidInventoryCursor("Invalid inventory cursor")


def parse_inventory_cursor(cursor: str | None) -> int | str | None:
    """Parse a public cursor into the offset type accepted by Qdrant.

    Short ASCII decimal values are point offsets. A 32-hex or canonical
    hyphenated UUID is a UUID point ID, including the all-decimal 32-hex form.
    """

    if cursor is None:
        return None
    if not isinstance(cursor, str) or not cursor or len(cursor) > MAX_INVENTORY_CURSOR_LENGTH:
        raise _invalid()

    if _ASCII_DECIMAL.fullmatch(cursor) is not None and len(cursor) <= 20:
        value = int(cursor)
        if value <= MAX_UNSIGNED_POINT_ID:
            return value
        raise _invalid()

    if _UUID_HEX.fullmatch(cursor) is not None or _UUID_HYPHENATED.fullmatch(cursor) is not None:
        try:
            return str(UUID(cursor))
        except (AttributeError, ValueError) as error:
            raise _invalid() from error

    raise _invalid()


def normalize_inventory_cursor_value(value: object) -> str | None:
    """Validate a Qdrant offset and return its canonical public form."""

    if value is None:
        return None
    if isinstance(value, bool):
        raise _invalid()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, int):
        parsed = parse_inventory_cursor(str(value))
    elif isinstance(value, str):
        parsed = parse_inventory_cursor(value)
    else:
        raise _invalid()
    return str(parsed)


__all__ = [
    "InvalidInventoryCursor",
    "MAX_INVENTORY_CURSOR_LENGTH",
    "MAX_UNSIGNED_POINT_ID",
    "normalize_inventory_cursor_value",
    "parse_inventory_cursor",
]
