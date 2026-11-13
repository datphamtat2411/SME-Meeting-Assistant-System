package com.sme.meetingassistant.api.assistant;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class AssistantAdmissionPropertiesTests {
    @Test
    void acceptsTheInitialEngineeringDefaults() {
        new AssistantAdmissionProperties(12, 600, 2, 20, 5, 20, 3600);
    }

    @Test
    void rejectsZeroAndNegativeSettings() {
        assertThatThrownBy(() -> new AssistantAdmissionProperties(0, 600, 2, 20, 5, 20, 3600))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AssistantAdmissionProperties(12, -1, 2, 20, 5, 20, 3600))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsUnreasonableAndContradictorySettings() {
        assertThatThrownBy(() -> new AssistantAdmissionProperties(100_001, 600, 2, 20, 5, 20, 3600))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AssistantAdmissionProperties(12, 600, 2, 1, 5, 20, 3600))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
