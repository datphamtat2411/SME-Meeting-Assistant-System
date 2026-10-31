package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.JobAdmissionConflictException;
import com.sme.meetingassistant.api.media.repository.MediaRepository.IdempotencyConflictException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Media-owned policy port for MI-08. Meeting Intelligence owns snapshot rows;
 * Media owns quotas, idempotency, job/stage records, and durable dispatch.
 * Both participate in one caller transaction, never a second media transaction.
 */
@Service
public class DerivedSummaryJobAdmission {
    private final MediaRepository repository;
    private final MediaProperties properties;
    public DerivedSummaryJobAdmission(MediaRepository repository,MediaProperties properties) {
        this.repository=repository;this.properties=properties;
    }

    public Optional<UUID> existing(UUID actor,UUID meetingId,String key) {
        return repository.findDerivedSummaryIdempotency(actor,operation(meetingId),key);
    }

    @Transactional(propagation=Propagation.MANDATORY)
    public void lockRequester(UUID actor) { repository.lockAdmissionUser(actor); }

    @Transactional(propagation=Propagation.MANDATORY)
    public Result admit(UUID actor,UUID meetingId,UUID mediaId,UUID originJobId,
            UUID proposedId,String idempotencyKey) {
        try {
            var claim=repository.claimIdempotencyWithStatus(
                actor,operation(meetingId),idempotencyKey,fingerprint(meetingId),proposedId);
            if(!claim.claimed()) {
                var existing=repository.findJob(claim.resourceId()).orElseThrow();
                return new Result(existing.id(),false);
            }
        } catch(IdempotencyConflictException conflicting) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Idempotency-Key already identifies another request.");
        }
        var origin=repository.findJob(originJobId).orElseThrow(() ->
            new ResponseStatusException(HttpStatus.CONFLICT,"Source transcript job is missing."));
        if (!origin.meetingId().equals(meetingId) || !origin.sourceMediaId().equals(mediaId)
                || !java.util.List.of("COMPLETED","COMPLETED_WITH_WARNINGS").contains(origin.status())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Regeneration requires a completed source processing job.");
        }
        if(repository.activeJobsForMeeting(meetingId)>0)
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Another processing job is already active for this meeting.");
        int maxActive=positive(properties.getAdmission().getMaxActiveJobsPerUser());
        if(repository.activeJobsForUser(actor)>=maxActive)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "Too many active processing jobs.");
        int period=positive(properties.getAdmission().getJobWindowMinutes());
        int limit=positive(properties.getAdmission().getMaxJobsPerWindow());
        if(repository.recentJobAdmissions(actor,period).count()>=limit)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "Processing admission rate limit exceeded.");
        try {
            repository.insertDerivedSummaryJobAndOutbox(proposedId,meetingId,mediaId,actor,
                originJobId,UUID.randomUUID());
        } catch(JobAdmissionConflictException duplicate) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Another processing job already occupies the meeting.");
        }
        return new Result(proposedId,true);
    }
    private static int positive(int value) {
        if(value<1) throw new IllegalStateException("Invalid processing quota configuration.");
        return value;
    }
    private static String operation(UUID meetingId) {return "SUMMARY_REGENERATION:"+meetingId;}
    private static String fingerprint(UUID meetingId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(("SUMMARY_REGENERATION:"+meetingId).getBytes(StandardCharsets.UTF_8)));
        } catch(NoSuchAlgorithmException impossible) {throw new IllegalStateException(impossible);}
    }
    public record Result(UUID jobId,boolean created) { }
}
