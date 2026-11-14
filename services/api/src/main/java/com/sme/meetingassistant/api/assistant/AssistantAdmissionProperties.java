package com.sme.meetingassistant.api.assistant;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Operator-tunable PostgreSQL-backed Assistant resource limits. */
@ConfigurationProperties(prefix = "app.assistant.admission")
public record AssistantAdmissionProperties(
        int maxAskRequestsPerUser,
        int askWindowSeconds,
        int maxActiveTurnsPerUser,
        int maxActiveTurnsGlobal,
        int maxActiveTurnsPerMeeting,
        int maxConversationCreationsPerUser,
        int conversationCreationWindowSeconds) {

    public AssistantAdmissionProperties {
        positiveBounded(maxAskRequestsPerUser, 100_000, "maxAskRequestsPerUser");
        positiveBounded(askWindowSeconds, 7 * 24 * 60 * 60, "askWindowSeconds");
        positiveBounded(maxActiveTurnsPerUser, 10_000, "maxActiveTurnsPerUser");
        positiveBounded(maxActiveTurnsGlobal, 100_000, "maxActiveTurnsGlobal");
        positiveBounded(maxActiveTurnsPerMeeting, 10_000, "maxActiveTurnsPerMeeting");
        positiveBounded(maxConversationCreationsPerUser, 100_000,
            "maxConversationCreationsPerUser");
        positiveBounded(conversationCreationWindowSeconds, 7 * 24 * 60 * 60,
            "conversationCreationWindowSeconds");
        if (maxActiveTurnsGlobal < maxActiveTurnsPerUser
                || maxActiveTurnsGlobal < maxActiveTurnsPerMeeting) {
            throw new IllegalArgumentException(
                "maxActiveTurnsGlobal must cover per-user and per-meeting limits");
        }
    }

    private static void positiveBounded(int value, int maximum, String name) {
        if (value < 1 || value > maximum) {
            throw new IllegalArgumentException("Invalid Assistant admission setting: " + name);
        }
    }
}
