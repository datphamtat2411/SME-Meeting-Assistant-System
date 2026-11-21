from uuid import UUID

import pytest

from sme_meeting_ai.rag.inventory_cursor import (
    MAX_UNSIGNED_POINT_ID,
    InvalidInventoryCursor,
    normalize_inventory_cursor_value,
    parse_inventory_cursor,
)


def test_parse_inventory_cursor_accepts_empty_start_and_unsigned_boundaries():
    assert parse_inventory_cursor(None) is None
    assert parse_inventory_cursor("0") == 0
    assert parse_inventory_cursor("0007") == 7
    assert parse_inventory_cursor(str(MAX_UNSIGNED_POINT_ID)) == MAX_UNSIGNED_POINT_ID


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (
            "22222222222222222222222222222222",
            "22222222-2222-2222-2222-222222222222",
        ),
        (
            "22222222-2222-4222-8222-222222222222",
            "22222222-2222-4222-8222-222222222222",
        ),
        (
            "22222222-2222-4222-8222-222222222222".upper(),
            "22222222-2222-4222-8222-222222222222",
        ),
    ],
)
def test_parse_inventory_cursor_normalizes_supported_uuid_forms(value, expected):
    assert parse_inventory_cursor(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        " ",
        " 7",
        "7 ",
        "abcd",
        "bad-cursor",
        "-1",
        "18446744073709551616",
        "123456789012345678901",
        "1234567890123456789012345678901",
        "1234567g-1234-1234-1234-123456789012",
        "12345678-1234-1234-1234-12345678901",
        "a" * 37,
        "１２３",
        "١٢٣",
        "{22222222-2222-4222-8222-222222222222}",
    ],
)
def test_parse_inventory_cursor_rejects_non_contract_values(value):
    with pytest.raises(InvalidInventoryCursor):
        parse_inventory_cursor(value)


@pytest.mark.parametrize("value", [True, False, 7, [], {}, UUID(int=0)])
def test_parse_inventory_cursor_rejects_non_string_input_types(value):
    with pytest.raises(InvalidInventoryCursor):
        parse_inventory_cursor(value)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (7, "7"),
        ("0007", "7"),
        (UUID("22222222-2222-4222-8222-222222222222"), "22222222-2222-4222-8222-222222222222"),
    ],
)
def test_normalize_inventory_cursor_value_canonicalizes_provider_offsets(value, expected):
    assert normalize_inventory_cursor_value(value) == expected


@pytest.mark.parametrize("value", [True, -1, 2**64, 1.0, [], {}, "abcd"])
def test_normalize_inventory_cursor_value_rejects_unexpected_provider_offsets(value):
    with pytest.raises(InvalidInventoryCursor):
        normalize_inventory_cursor_value(value)
