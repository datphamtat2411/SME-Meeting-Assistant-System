package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.entity.MeetingMediaEntity;
import com.sme.meetingassistant.api.media.entity.MediaAvailabilityStatus;
import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobIdempotencyEntity;
import com.sme.meetingassistant.api.media.entity.OutboxEventEntity;
import com.sme.meetingassistant.api.media.repository.MeetingMediaRepository;
import com.sme.meetingassistant.api.media.repository.OutboxEventRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobIdempotencyRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobRepository;
import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProcessingJobService {

	private static final String JOB_REQUESTED_EVENT = "processing.job.requested.v1";
	private final MeetingAccess meetingAccess;
	private final MeetingMediaRepository mediaRepository;
	private final ProcessingJobRepository jobRepository;
	private final ProcessingJobIdempotencyRepository idempotencyRepository;
	private final OutboxEventRepository outboxRepository;

	public ProcessingJobService(MeetingAccess meetingAccess, MeetingMediaRepository mediaRepository,
			ProcessingJobRepository jobRepository, ProcessingJobIdempotencyRepository idempotencyRepository,
			OutboxEventRepository outboxRepository) {
		this.meetingAccess = meetingAccess;
		this.mediaRepository = mediaRepository;
		this.jobRepository = jobRepository;
		this.idempotencyRepository = idempotencyRepository;
		this.outboxRepository = outboxRepository;
	}

	@Transactional
	public ProcessingJobResponse create(UUID meetingId, UUID mediaId, UUID callerId, String idempotencyKey) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		MeetingMediaEntity media = this.mediaRepository.findByIdAndMeetingIdForUpdate(mediaId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (media.getAvailabilityStatus() != MediaAvailabilityStatus.AVAILABLE) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		String fingerprint = fingerprint(meetingId, mediaId);
		var priorRequest = this.idempotencyRepository.findByRequesterIdAndIdempotencyKey(callerId, idempotencyKey);
		if (priorRequest.isPresent()) {
			if (!priorRequest.get().getRequestFingerprint().equals(fingerprint)) {
				throw new ResponseStatusException(HttpStatus.CONFLICT);
			}
			ProcessingJobEntity existing = this.jobRepository.findById(priorRequest.get().getJobId())
					.orElseThrow(() -> new IllegalStateException("Idempotency record has no processing job."));
			return ProcessingJobResponse.from(existing);
		}

		ProcessingJobEntity job = this.jobRepository.saveAndFlush(new ProcessingJobEntity(media.getId(), callerId));
		try {
			this.idempotencyRepository.saveAndFlush(
					new ProcessingJobIdempotencyEntity(callerId, idempotencyKey, fingerprint, job.getId()));
		}
		catch (DataIntegrityViolationException duplicateKey) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicateKey);
		}
		String payload = "{\"jobId\":\"%s\",\"meetingId\":\"%s\",\"mediaId\":\"%s\"}"
				.formatted(job.getId(), meetingId, media.getId());
		this.outboxRepository.save(new OutboxEventEntity(job.getId(), JOB_REQUESTED_EVENT, payload));
		return ProcessingJobResponse.from(job);
	}

	@Transactional(readOnly = true)
	public ProcessingJobResponse get(UUID jobId, UUID callerId) {
		ProcessingJobEntity job = this.jobRepository.findById(jobId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		MeetingMediaEntity media = this.mediaRepository.findById(job.getMediaId())
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		this.meetingAccess.requireAccessible(media.getMeetingId(), callerId);
		return ProcessingJobResponse.from(job);
	}

	private static String fingerprint(UUID meetingId, UUID mediaId) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256")
					.digest((meetingId + ":" + mediaId).getBytes(StandardCharsets.UTF_8));
			return HexFormat.of().formatHex(digest);
		}
		catch (NoSuchAlgorithmException exception) {
			throw new IllegalStateException("SHA-256 is unavailable.", exception);
		}
	}

}
