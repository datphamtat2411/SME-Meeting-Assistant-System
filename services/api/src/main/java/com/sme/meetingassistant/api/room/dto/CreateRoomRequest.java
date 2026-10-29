package com.sme.meetingassistant.api.room.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

public record CreateRoomRequest(
    @NotBlank @Size(max = 64) String code,
    @NotBlank @Size(max = 160) String name,
    @Size(max = 255) String location,
    @Positive Integer capacity,
    String notes
) { }
