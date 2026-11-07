package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.actionitems.ActionItemLifecycle.Command;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Command identity is part of the business state machine, not just target state. */
class ActionItemLifecycleTests {
    @Test void canonicalCommandsHaveExactSourceAndTargetStates() {
        assertThat(ActionItemLifecycle.target(Command.CONFIRM,ActionItemStatus.PROPOSED))
            .isEqualTo(ActionItemStatus.OPEN);
        assertThat(ActionItemLifecycle.target(Command.REJECT,ActionItemStatus.PROPOSED))
            .isEqualTo(ActionItemStatus.CANCELLED);
        assertThat(ActionItemLifecycle.target(Command.START,ActionItemStatus.OPEN))
            .isEqualTo(ActionItemStatus.IN_PROGRESS);
        for (var from : new ActionItemStatus[]{ActionItemStatus.OPEN,ActionItemStatus.IN_PROGRESS}) {
            assertThat(ActionItemLifecycle.target(Command.COMPLETE,from))
                .isEqualTo(ActionItemStatus.DONE);
            assertThat(ActionItemLifecycle.target(Command.CANCEL,from))
                .isEqualTo(ActionItemStatus.CANCELLED);
        }
        assertThat(ActionItemLifecycle.target(Command.REOPEN,ActionItemStatus.DONE))
            .isEqualTo(ActionItemStatus.OPEN);
        assertThat(ActionItemLifecycle.requiresManager(Command.CONFIRM)).isTrue();
        assertThat(ActionItemLifecycle.requiresManager(Command.REJECT)).isTrue();
        assertThat(ActionItemLifecycle.requiresManager(Command.CANCEL)).isTrue();
        assertThat(ActionItemLifecycle.requiresManager(Command.COMPLETE)).isFalse();
        assertThat(ActionItemLifecycle.requiresManager(Command.REOPEN)).isFalse();
    }

    @Test void unrelatedCommandsCanNeverBeUsedAsAnAlternativeStateTransition() {
        for (var command : Command.values()) {
            for (var source : ActionItemStatus.values()) {
                boolean valid = switch (command) {
                    case CONFIRM,REJECT -> source==ActionItemStatus.PROPOSED;
                    case START -> source==ActionItemStatus.OPEN;
                    case COMPLETE,CANCEL -> source==ActionItemStatus.OPEN
                        || source==ActionItemStatus.IN_PROGRESS;
                    case REOPEN -> source==ActionItemStatus.DONE;
                };
                if (!valid) {
                    assertThatThrownBy(() -> ActionItemLifecycle.target(command,source))
                        .isInstanceOf(ResponseStatusException.class)
                        .satisfies(t -> assertThat(((ResponseStatusException)t).getStatusCode())
                            .isEqualTo(HttpStatus.CONFLICT));
                }
            }
        }
    }
}
