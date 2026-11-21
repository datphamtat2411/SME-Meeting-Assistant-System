package com.sme.meetingassistant.api.knowledge;

import java.math.BigInteger;
import java.util.UUID;
import java.util.regex.Pattern;

/** Shared Core-side grammar and canonicalization for the AI inventory cursor. */
final class InventoryCursor {
    static final int MAX_LENGTH = 36;
    private static final BigInteger MAX_UNSIGNED_POINT_ID = new BigInteger("18446744073709551615");
    private static final Pattern ASCII_DECIMAL = Pattern.compile("[0-9]+");
    private static final Pattern UUID_HEX = Pattern.compile("[0-9a-fA-F]{32}");
    private static final Pattern UUID_HYPHENATED = Pattern.compile(
        "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");

    private InventoryCursor() { }

    static String normalize(String cursor) {
        if (cursor == null) return null;
        if (cursor.isEmpty() || cursor.length() > MAX_LENGTH) throw invalid();

        if (ASCII_DECIMAL.matcher(cursor).matches() && cursor.length() <= 20) {
            BigInteger value = new BigInteger(cursor);
            if (value.compareTo(MAX_UNSIGNED_POINT_ID) <= 0) return value.toString();
            throw invalid();
        }

        if (UUID_HEX.matcher(cursor).matches() || UUID_HYPHENATED.matcher(cursor).matches()) {
            try {
                String canonical = cursor.length() == 32 ? hyphenate(cursor) : cursor;
                return UUID.fromString(canonical).toString();
            } catch (IllegalArgumentException error) {
                throw invalid();
            }
        }
        throw invalid();
    }

    private static String hyphenate(String value) {
        return value.substring(0, 8) + "-" + value.substring(8, 12) + "-"
            + value.substring(12, 16) + "-" + value.substring(16, 20) + "-"
            + value.substring(20);
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid inventory cursor");
    }
}
