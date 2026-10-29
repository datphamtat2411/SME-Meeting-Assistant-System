package com.sme.meetingassistant.api.common;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import io.swagger.v3.oas.annotations.media.Schema;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;

public record ApiMeta(
    String requestId,
    @Schema(type = "string", format = "date-time", example = "2026-01-02T10:34:56Z")
    @JsonFormat(shape = JsonFormat.Shape.STRING) OffsetDateTime timestamp,
    @JsonInclude(JsonInclude.Include.NON_NULL) ApiPagination pagination) {

    public ApiMeta(String requestId, OffsetDateTime timestamp) {
        this(requestId, timestamp, null);
    }

    public ApiMeta {
        Objects.requireNonNull(timestamp, "timestamp");
        timestamp = timestamp.withOffsetSameInstant(ZoneOffset.UTC);
    }
}
