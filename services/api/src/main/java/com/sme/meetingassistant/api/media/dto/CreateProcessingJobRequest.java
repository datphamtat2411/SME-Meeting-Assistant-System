package com.sme.meetingassistant.api.media.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record CreateProcessingJobRequest(@NotNull UUID mediaId) { }
