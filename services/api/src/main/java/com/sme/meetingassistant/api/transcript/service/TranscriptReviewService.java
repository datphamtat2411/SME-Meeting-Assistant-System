package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.transcript.dto.CorrectTranscriptSegmentRequest;
import com.sme.meetingassistant.api.transcript.dto.MapSpeakerRequest;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CorrectionView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CoverageView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SpeakerView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.TranscriptView;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.SpeakerMapResult;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class TranscriptReviewService implements TranscriptIngestion {
    private final TranscriptRepository repository;
    private final MeetingMediaAccess meetingAccess;
    private final AuthenticatedUserId authenticatedUser;

    public TranscriptReviewService(TranscriptRepository repository, MeetingMediaAccess meetingAccess,
            AuthenticatedUserId authenticatedUser) {
        this.repository = repository;
        this.meetingAccess = meetingAccess;
        this.authenticatedUser = authenticatedUser;
    }

    @Override
    @Transactional
    public void publish(TranscriptResult result) {
        this.repository.publish(result);
    }

    @Transactional(readOnly = true)
    public TranscriptView current(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.current(meetingId).orElseThrow(TranscriptReviewService::notFound);
    }

    @Transactional(readOnly = true)
    public List<CoverageView> coverage(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.coverage(meetingId);
    }

    @Transactional(readOnly = true)
    public List<SpeakerView> speakers(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.speakers(meetingId);
    }

    @Transactional
    public CorrectionView correct(UUID meetingId, UUID segmentId, String ifMatch,
            CorrectTranscriptSegmentRequest request) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.repository.lockMeetingForReview(meetingId);
        this.meetingAccess.requireTranscriptEditAllowed(meetingId, actor);
        long version = segmentVersion(segmentId, ifMatch);
        if (request == null || request.text() == null || request.text().isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        return this.repository.correct(meetingId, segmentId, actor, request.text().trim(), request.reason(), version);
    }

    @Transactional
    public SpeakerMapResult mapSpeaker(UUID meetingId, UUID clusterId, String ifMatch,
            MapSpeakerRequest request) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.repository.lockMeetingForReview(meetingId);
        this.meetingAccess.requireTranscriptEditAllowed(meetingId, actor);
        if (request != null && request.userId() != null) {
            this.meetingAccess.requireTranscriptSpeakerMember(meetingId, request.userId());
        }
        TranscriptTag tag = transcriptTag(ifMatch);
        return this.repository.mapSpeaker(meetingId, clusterId,
            request == null ? null : request.userId(), actor, tag.transcriptId(), tag.revision());
    }

    /** ETag binds the current transcript identity to its content revision. */
    private static TranscriptTag transcriptTag(String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        if (!ifMatch.startsWith("\"t-") || !ifMatch.endsWith("\"")) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        String value = ifMatch.substring(3, ifMatch.length() - 1);
        int boundary = value.lastIndexOf('-');
        if (boundary <= 0 || boundary == value.length() - 1) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        try {
            UUID id = UUID.fromString(value.substring(0, boundary));
            long revision = Long.parseLong(value.substring(boundary + 1));
            if (revision < 0) throw new IllegalArgumentException();
            return new TranscriptTag(id, revision);
        } catch (IllegalArgumentException error) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }

    private record TranscriptTag(UUID transcriptId, long revision) {}

    private static long segmentVersion(UUID segmentId, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        String prefix = "\"s-" + segmentId + "-";
        if (!ifMatch.startsWith(prefix) || !ifMatch.endsWith("\"")) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        try {
            long version = Long.parseLong(ifMatch.substring(prefix.length(), ifMatch.length() - 1));
            if (version < 0) throw new NumberFormatException();
            return version;
        } catch (NumberFormatException e) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
