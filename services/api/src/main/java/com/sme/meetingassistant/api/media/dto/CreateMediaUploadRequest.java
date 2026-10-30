package com.sme.meetingassistant.api.media.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

public record CreateMediaUploadRequest(
    @NotNull SourceType sourceType,
    @NotBlank String originalFilename,
    @NotBlank String contentType,
    @NotNull @Positive Long expectedSizeBytes
) {
    public enum SourceType { UPLOAD, RECORDING }
}
