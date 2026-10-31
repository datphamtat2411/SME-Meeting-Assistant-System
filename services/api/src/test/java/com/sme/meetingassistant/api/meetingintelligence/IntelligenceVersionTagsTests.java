package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceVersionTags;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class IntelligenceVersionTagsTests {
    @Test
    void summaryTokenChangesOnEditOrCandidateActivation() {
        UUID versionA = UUID.randomUUID();
        UUID versionB = UUID.randomUUID();
        String first = IntelligenceVersionTags.summary(versionA, 1);
        String second = IntelligenceVersionTags.summary(versionB, 2);
        assertThat(first).startsWith("\"sum-").endsWith("\"");
        assertThat(first).isNotEqualTo(second);
        IntelligenceVersionTags.requireSummaryMatch(versionA, 1, first);
        assertStatus(HttpStatus.PRECONDITION_FAILED,
            () -> IntelligenceVersionTags.requireSummaryMatch(versionB, 2, first));
    }

    @Test
    void decisionTagCannotBeSubstitutedForSummaryTag() {
        UUID decision = UUID.randomUUID();
        UUID version = UUID.randomUUID();
        String tag = IntelligenceVersionTags.decision(decision, 5);
        assertThat(tag).startsWith("\"dec-").endsWith("\"");
        IntelligenceVersionTags.requireDecisionMatch(decision, 5, tag);
        assertStatus(HttpStatus.PRECONDITION_FAILED,
            () -> IntelligenceVersionTags.requireSummaryMatch(version, 5, tag));
        assertStatus(HttpStatus.PRECONDITION_FAILED,
            () -> IntelligenceVersionTags.requireDecisionMatch(decision, 6, tag));
    }

    @Test
    void missingPreconditionFailsClosedAndWildcardIsRejected() {
        UUID id = UUID.randomUUID();
        assertStatus(HttpStatus.PRECONDITION_REQUIRED,
            () -> IntelligenceVersionTags.requireDecisionMatch(id, 0, null));
        assertStatus(HttpStatus.PRECONDITION_REQUIRED,
            () -> IntelligenceVersionTags.requireSummaryMatch(id, 1, " "));
        assertStatus(HttpStatus.PRECONDITION_FAILED,
            () -> IntelligenceVersionTags.requireSummaryMatch(id, 1, "*"));
    }

    private static void assertStatus(HttpStatus expected, Runnable action) {
        ResponseStatusException error = catchThrowableOfType(ResponseStatusException.class, action::run);
        assertThat(error).isNotNull();
        assertThat(error.getStatusCode()).isEqualTo(expected);
    }
}
