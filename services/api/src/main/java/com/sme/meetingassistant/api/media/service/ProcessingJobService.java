package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.dto.ProcessingJobAttemptResponse;
import com.sme.meetingassistant.api.media.entity.MeetingMediaEntity;
import com.sme.meetingassistant.api.media.entity.MediaAvailabilityStatus;
import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobAttemptEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobCommandIdempotencyEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobIdempotencyEntity;
import com.sme.meetingassistant.api.media.entity.OutboxEventEntity;
import com.sme.meetingassistant.api.media.repository.MeetingMediaRepository;
import com.sme.meetingassistant.api.media.repository.OutboxEventRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobAttemptRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobCommandIdempotencyRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobIdempotencyRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobRepository;
import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
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
	private final ProcessingJobCommandIdempotencyRepository commandIdempotencyRepository;
	private final ProcessingJobAttemptRepository attemptRepository;
	private final OutboxEventRepository outboxRepository;

	public ProcessingJobService(MeetingAccess meetingAccess, MeetingMediaRepository mediaRepository,
			ProcessingJobRepository jobRepository, ProcessingJobIdempotencyRepository idempotencyRepository,
			ProcessingJobCommandIdempotencyRepository commandIdempotencyRepository,
			ProcessingJobAttemptRepository attemptRepository, OutboxEventRepository outboxRepository) {
		this.meetingAccess = meetingAccess;
		this.mediaRepository = mediaRepository;
		this.jobRepository = jobRepository;
		this.idempotencyRepository = idempotencyRepository;
		this.commandIdempotencyRepository = commandIdempotencyRepository;
		this.attemptRepository = attemptRepository;
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
		String fingerprint = fingerprint("INITIAL:" + meetingId + ":" + mediaId);
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

	@Transactional
	public ProcessingJobResponse retry(UUID jobId, UUID callerId, String idempotencyKey) {
		ProcessingJobEntity job = accessibleJobForUpdate(jobId, callerId);
		String fingerprint = fingerprint("RETRY:" + jobId);
		var previous = this.commandIdempotencyRepository.findByRequesterIdAndIdempotencyKey(callerId, idempotencyKey);
		if (previous.isPresent()) {
			if (!previous.get().getRequestFingerprint().equals(fingerprint)
					|| !previous.get().getCommandType().equals("RETRY")) {
				throw new ResponseStatusException(HttpStatus.CONFLICT);
			}
			return ProcessingJobResponse.from(this.jobRepository.findById(previous.get().getJobId())
					.orElseThrow(() -> new IllegalStateException("Retry idempotency record has no processing job.")));
		}

		OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
		job.retryNow(now);
		this.jobRepository.flush();
		try {
			this.commandIdempotencyRepository.saveAndFlush(new ProcessingJobCommandIdempotencyEntity(callerId,
					idempotencyKey, fingerprint, job.getId(), "RETRY"));
		}
		catch (DataIntegrityViolationException duplicateKey) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicateKey);
		}
		this.outboxRepository.save(new OutboxEventEntity(job.getId(), "processing.job.retry.requested.v1",
				jobPayload(job, now), now));
		return ProcessingJobResponse.from(job);
	}

	@Transactional
	public ProcessingJobResponse reprocess(UUID jobId, UUID callerId, String idempotencyKey) {
		ProcessingJobEntity source = accessibleJobForUpdate(jobId, callerId);
		if (source.getStatus() != com.sme.meetingassistant.api.media.entity.ProcessingJobStatus.SUCCEEDED
				&& source.getStatus() != com.sme.meetingassistant.api.media.entity.ProcessingJobStatus.FAILED) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		String fingerprint = fingerprint("REPROCESS:" + jobId);
		var priorRequest = this.idempotencyRepository.findByRequesterIdAndIdempotencyKey(callerId, idempotencyKey);
		if (priorRequest.isPresent()) {
			if (!priorRequest.get().getRequestFingerprint().equals(fingerprint)) {
				throw new ResponseStatusException(HttpStatus.CONFLICT);
			}
			ProcessingJobEntity existing = this.jobRepository.findById(priorRequest.get().getJobId())
					.orElseThrow(() -> new IllegalStateException("Idempotency record has no processing job."));
			return ProcessingJobResponse.from(existing);
		}

		ProcessingJobEntity job = this.jobRepository.saveAndFlush(new ProcessingJobEntity(source.getMediaId(), callerId,
				source.getId(), com.sme.meetingassistant.api.media.entity.ProcessingJobRequestType.REPROCESS));
		try {
			this.idempotencyRepository.saveAndFlush(
					new ProcessingJobIdempotencyEntity(callerId, idempotencyKey, fingerprint, job.getId()));
		}
		catch (DataIntegrityViolationException duplicateKey) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicateKey);
		}
		this.outboxRepository.save(new OutboxEventEntity(job.getId(), JOB_REQUESTED_EVENT, jobPayload(job, null)));
		return ProcessingJobResponse.from(job);
	}

	@Transactional(readOnly = true)
	public ProcessingJobResponse get(UUID jobId, UUID callerId) {
		ProcessingJobEntity job = accessibleJob(jobId, callerId);
		return ProcessingJobResponse.from(job);
	}

	@Transactional(readOnly = true)
	public List<ProcessingJobAttemptResponse> getAttempts(UUID jobId, UUID callerId) {
		accessibleJob(jobId, callerId);
		return this.attemptRepository.findAllByJobIdOrderByAttemptNumberAsc(jobId).stream()
				.map(ProcessingJobAttemptResponse::from).toList();
	}

	private ProcessingJobEntity accessibleJob(UUID jobId, UUID callerId) {
		ProcessingJobEntity job = this.jobRepository.findById(jobId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
			MeetingMediaEntity media = this.mediaRepository.findById(job.getMediaId())
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
			this.meetingAccess.requireAccessible(media.getMeetingId(), callerId);
			return job;
	}

	private ProcessingJobEntity accessibleJobForUpdate(UUID jobId, UUID callerId) {
		ProcessingJobEntity job = this.jobRepository.findByIdForUpdate(jobId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		MeetingMediaEntity media = this.mediaRepository.findById(job.getMediaId())
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		this.meetingAccess.requireAccessible(media.getMeetingId(), callerId);
		return job;
	}

	static String jobPayload(ProcessingJobEntity job, OffsetDateTime notBefore) {
		String schedule = notBefore == null ? "null" : "\"" + notBefore + "\"";
		return "{\"jobId\":\"%s\",\"mediaId\":\"%s\",\"attemptCount\":%d,\"notBefore\":%s}"
				.formatted(job.getId(), job.getMediaId(), job.getAttemptCount(), schedule);
	}

	private static String fingerprint(String value) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256")
					.digest(value.getBytes(StandardCharsets.UTF_8));
			return HexFormat.of().formatHex(digest);
		}
		catch (NoSuchAlgorithmException exception) {
			throw new IllegalStateException("SHA-256 is unavailable.", exception);
		}
	}

}
