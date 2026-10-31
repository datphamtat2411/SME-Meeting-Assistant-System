package com.sme.meetingassistant.api.actionitems.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.UUID;

public record CreateActionItemRequest(@NotNull UUID meetingId,
        @NotBlank @Size(max=500) String title, @Size(max=10000) String details,
        @NotNull UUID assigneeUserId, LocalDate dueDate) { }
