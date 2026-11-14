package com.sme.meetingassistant.api.assistant;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Public, bounded DTOs. Never serialize canonical entities or AI transport internals. */
public final class AssistantModels {
    private AssistantModels() {}

    public record CreateConversation(@NotNull UUID meetingId, @Size(max=255) String title) {}
    public record Ask(@NotBlank @Size(max=4096) String question) {}

    public record ConversationView(UUID id, UUID meetingId, String title, String status,
                                   OffsetDateTime createdAt, OffsetDateTime updatedAt) {}
    public record ClaimView(String claimId, String text, String support, List<String> citationIds) {}
    public record CitationView(String citationId, String sourceType, UUID sourceId, UUID meetingId,
                               long sourceRevision, String retrievalChunkId, List<String> claimIds) {}
    public record MessageView(UUID id, String role, String content, String answerStatus,
                              String visibility, List<ClaimView> claims, List<CitationView> citations,
                              OffsetDateTime createdAt) {}
    public record ConversationDetail(ConversationView conversation, List<MessageView> messages,
                                     int page, int size, boolean hasMore) {}
    public record TurnView(UUID turnId, String state, UUID userMessageId, UUID assistantMessageId,
                           String answerStatus, String answer, List<ClaimView> claims,
                           List<CitationView> citations) {}
    public record TurnOutcome(int httpStatus, TurnView result) {}

    /** AI-only result validated before it is eligible for canonical persistence. */
    record ValidatedAnswer(String status, String text, JsonNode claims, JsonNode diagnostics,
                           JsonNode provenance, List<CitationView> citations, List<ClaimView> claimViews) {}
}
