package com.sme.meetingassistant.api.media.dto;

import java.time.OffsetDateTime;

public record MediaAccessUrlResponse(String url, OffsetDateTime expiresAt) { }
