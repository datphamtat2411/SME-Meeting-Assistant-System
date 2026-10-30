package com.sme.meetingassistant.api.transcript.dto;

import java.util.UUID;

/** A null userId removes the mapping and leaves the AI-derived label unresolved. */
public record MapSpeakerRequest(UUID userId) {}
