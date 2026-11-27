package com.sme.meetingassistant.api.transcript.service;

import java.util.UUID;

/** An authorized edit committed with a new canonical transcript content revision. */
public record TranscriptRevisionChanged(UUID meetingId, UUID transcriptId, long contentRevision, UUID actorId) {}
