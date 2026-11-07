package com.sme.meetingassistant.api.actionitems;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Commands have distinct meanings even if they share a target state.
 * Confirmation is never reopening, and rejection is never cancellation.
 */
public final class ActionItemLifecycle {
    private ActionItemLifecycle() {}

    public enum Command { CONFIRM, REJECT, START, COMPLETE, CANCEL, REOPEN }

    public static ActionItemStatus target(Command command, ActionItemStatus from) {
        boolean allowed = switch (command) {
            case CONFIRM, REJECT -> from == ActionItemStatus.PROPOSED;
            case START -> from == ActionItemStatus.OPEN;
            case COMPLETE -> from == ActionItemStatus.OPEN || from == ActionItemStatus.IN_PROGRESS;
            case CANCEL -> from == ActionItemStatus.OPEN || from == ActionItemStatus.IN_PROGRESS;
            case REOPEN -> from == ActionItemStatus.DONE;
        };
        if (!allowed) throw new ResponseStatusException(HttpStatus.CONFLICT,
            "Action Item command is not valid in current state");
        return switch (command) {
            case CONFIRM, REOPEN -> ActionItemStatus.OPEN;
            case REJECT, CANCEL -> ActionItemStatus.CANCELLED;
            case START -> ActionItemStatus.IN_PROGRESS;
            case COMPLETE -> ActionItemStatus.DONE;
        };
    }

    public static boolean requiresManager(Command command) {
        return command == Command.CONFIRM || command == Command.REJECT
            || command == Command.CANCEL;
    }
}
