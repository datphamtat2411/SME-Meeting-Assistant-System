package com.sme.meetingassistant.api.actionitems;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

public final class ActionItemEtags {
    private ActionItemEtags() { }
    public static String of(ActionItemView item) { return "\"a-" + item.id() + "-" + item.version() + "\""; }
    public static void requireMatch(ActionItemView item, String value) {
        if (value == null || value.isBlank()) throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        if (!of(item).equals(value)) throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
    }
}
