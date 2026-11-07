package com.sme.meetingassistant.api.notification.preferences;

import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.IllformedLocaleException;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;

/**
 * Exact partial-update intent. Omitted properties are unchanged; JSON null
 * clears only timezone/locale, never optional email flags.
 */
public record PatchNotificationPreferencesRequest(
        boolean timezonePresent, String timezone,
        boolean localePresent, String locale,
        boolean meetingEmailPresent, boolean meetingEmailEnabled,
        boolean actionItemEmailPresent, boolean actionItemEmailEnabled) {

    public static PatchNotificationPreferencesRequest from(JsonNode object) {
        if (object == null || !object.isObject()) throw invalid();
        boolean timezonePresent = object.has("timezone");
        boolean localePresent = object.has("locale");
        boolean meetingPresent = object.has("meetingEmailEnabled");
        boolean actionPresent = object.has("actionItemEmailEnabled");
        int provided = (timezonePresent ? 1 : 0) + (localePresent ? 1 : 0)
                + (meetingPresent ? 1 : 0) + (actionPresent ? 1 : 0);
        // Reject empty, unknown or unexpected JSON structure. No implicit coercion.
        if (provided == 0 || provided != object.size()) throw invalid();

        return new PatchNotificationPreferencesRequest(
                timezonePresent, timezonePresent ? timezone(object.get("timezone")) : null,
                localePresent, localePresent ? locale(object.get("locale")) : null,
                meetingPresent, meetingPresent && strictBoolean(object.get("meetingEmailEnabled")),
                actionPresent, actionPresent && strictBoolean(object.get("actionItemEmailEnabled")));
    }

    private static String timezone(JsonNode node) {
        if (node == null || node.isNull()) return null;
        if (!node.isTextual()) throw invalid();
        String value = node.asText();
        if (value.isBlank() || value.length() > 64) throw invalid();
        try {
            // Do not silently accept fixed-offset or abbreviated IDs as IANA zone names.
            if (!ZoneId.getAvailableZoneIds().contains(value)) throw invalid();
            ZoneId.of(value);
        } catch (DateTimeException bad) { throw invalid(); }
        return value;
    }

    private static String locale(JsonNode node) {
        if (node == null || node.isNull()) return null;
        if (!node.isTextual()) throw invalid();
        String value = node.asText();
        if (value.isBlank() || value.length() > 32
                || value.chars().anyMatch(Character::isWhitespace)) throw invalid();
        try {
            Locale parsed = new Locale.Builder().setLanguageTag(value).build();
            if (parsed.getLanguage().isBlank() || "und".equals(parsed.toLanguageTag())) {
                throw invalid();
            }
            return parsed.toLanguageTag();
        } catch (IllformedLocaleException bad) { throw invalid(); }
    }

    private static boolean strictBoolean(JsonNode node) {
        if (node == null || !node.isBoolean()) throw invalid();
        return node.asBoolean();
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Invalid notification preferences patch fields");
    }
}
