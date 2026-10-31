package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.meetingintelligence.dto.CreateDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditSummaryRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.lang.reflect.RecordComponent;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class IntelligenceContractValidationTests {
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    @Test
    void summaryAndDecisionEditsRequireNonblankBoundedContent() {
        assertThat(validator.validate(new EditSummaryRequest("   "))).isNotEmpty();
        assertThat(validator.validate(new EditSummaryRequest("x".repeat(20_001)))).isNotEmpty();
        assertThat(validator.validate(new EditSummaryRequest("Summary approved by human."))).isEmpty();
        assertThat(validator.validate(new EditDecisionRequest(""))).isNotEmpty();
        assertThat(validator.validate(new EditDecisionRequest("x".repeat(5_001)))).isNotEmpty();
        assertThat(validator.validate(new EditDecisionRequest("Approved milestone."))).isEmpty();
    }

    @Test
    void manualDecisionEvidenceIsOptionalButBoundedAndNonNull() {
        assertThat(validator.validate(new CreateDecisionRequest("Manual decision.", null))).isEmpty();
        assertThat(validator.validate(new CreateDecisionRequest("Manual decision.", List.of(UUID.randomUUID())))).isEmpty();
        assertThat(validator.validate(new CreateDecisionRequest("Manual decision.", Collections.nCopies(51, UUID.randomUUID())))).isNotEmpty();
        assertThat(validator.validate(new CreateDecisionRequest("Manual decision.", Arrays.asList((UUID) null)))).isNotEmpty();
    }

    @Test
    void mutationRecordsExposeOnlyAllowlistedFields() {
        assertThat(fields(EditSummaryRequest.class)).containsExactly("content");
        assertThat(fields(EditDecisionRequest.class)).containsExactly("content");
        assertThat(fields(CreateDecisionRequest.class)).containsExactlyInAnyOrder("content", "evidenceSegmentIds");
    }

    @Test
    void decisionReadModelDoesNotLeakMutableEvidenceLists() {
        java.util.ArrayList<UUID> evidence = new java.util.ArrayList<>(List.of(UUID.randomUUID()));
        DecisionView view = new DecisionView(UUID.randomUUID(), UUID.randomUUID(), "Decision",
            "PROPOSED", "AI_EXTRACTED", evidence, null, null, false, 0L,
            OffsetDateTime.now(), null, null, null, null, null);
        evidence.clear();
        assertThat(view.evidenceSegmentIds()).hasSize(1);
    }

    private static Set<String> fields(Class<?> type) {
        return Arrays.stream(type.getRecordComponents())
            .map(RecordComponent::getName).collect(Collectors.toSet());
    }
}
