package com.sme.meetingassistant.api.actionitems.dto;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;

/**
 * Typed PATCH intent. Presence and explicit null are different: an omitted
 * property is unchanged; null clears details/due date or a PROPOSED assignee.
 * Null title and any unknown/mistyped fields fail closed.
 */
public record PatchActionItemRequest(
    boolean titlePresent, String title,
    boolean detailsPresent, String details,
    boolean assigneePresent, UUID assigneeUserId,
    boolean dueDatePresent, LocalDate dueDate) {

    public static PatchActionItemRequest from(JsonNode object) {
        if (object == null || !object.isObject()) throw invalid();
        boolean titlePresent = object.has("title");
        boolean detailsPresent = object.has("details");
        boolean assigneePresent = object.has("assigneeUserId");
        boolean duePresent = object.has("dueDate");
        int known = (titlePresent ? 1 : 0) + (detailsPresent ? 1 : 0)
            + (assigneePresent ? 1 : 0) + (duePresent ? 1 : 0);
        if (known == 0 || known != object.size()) throw invalid();

        String title = null;
        if (titlePresent) {
            JsonNode n = object.get("title");
            if (n == null || !n.isTextual()) throw invalid();
            title = n.asText();
        }
        String details = null;
        if (detailsPresent) {
            JsonNode n = object.get("details");
            if (n == null || (!n.isNull() && !n.isTextual())) throw invalid();
            if (!n.isNull()) details = n.asText();
        }
        UUID assignee = null;
        if (assigneePresent) {
            JsonNode n = object.get("assigneeUserId");
            if (n == null || (!n.isNull() && !n.isTextual())) throw invalid();
            if (!n.isNull()) {
                try {
                    assignee = UUID.fromString(n.asText());
                    if (!assignee.toString().equalsIgnoreCase(n.asText())) throw invalid();
                } catch (IllegalArgumentException bad) { throw invalid(); }
            }
        }
        LocalDate dueDate = null;
        if (duePresent) {
            JsonNode n = object.get("dueDate");
            if (n == null || (!n.isNull() && !n.isTextual())) throw invalid();
            if (!n.isNull()) {
                try { dueDate = LocalDate.parse(n.asText()); }
                catch (DateTimeParseException bad) { throw invalid(); }
            }
        }
        return new PatchActionItemRequest(titlePresent, title, detailsPresent, details,
            assigneePresent, assignee, duePresent, dueDate);
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
            "Invalid Action Item patch fields");
    }
}
