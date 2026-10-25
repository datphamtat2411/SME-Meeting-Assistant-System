package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import com.sme.meetingassistant.api.transcript.dto.TranscriptResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentInput;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentRevisionResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentUpdateResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptVersionResponse;
import com.sme.meetingassistant.api.transcript.dto.UpdateTranscriptSegmentRequest;
import com.sme.meetingassistant.api.transcript.entity.TranscriptEntity;
import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentEntity;
import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentRevisionEntity;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptSegmentRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptSegmentRevisionRepository;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class TranscriptService implements TranscriptEvidenceAccess {

	private final MeetingAccess meetingAccess;
	private final TranscriptRepository transcriptRepository;
	private final TranscriptSegmentRepository segmentRepository;
	private final TranscriptSegmentRevisionRepository revisionRepository;

	public TranscriptService(MeetingAccess meetingAccess, TranscriptRepository transcriptRepository,
			TranscriptSegmentRepository segmentRepository,
			TranscriptSegmentRevisionRepository revisionRepository) {
		this.meetingAccess = meetingAccess;
		this.transcriptRepository = transcriptRepository;
		this.segmentRepository = segmentRepository;
		this.revisionRepository = revisionRepository;
	}

	public TranscriptResponse ingest(UUID meetingId, UUID actorId, UUID sourceProcessingJobId, String language,
			List<TranscriptSegmentInput> segments) {
		this.meetingAccess.requireAccessible(meetingId, actorId);
		validateIngestion(sourceProcessingJobId, language, segments);
		this.transcriptRepository.findCurrentForUpdate(meetingId).ifPresent(TranscriptEntity::markNotCurrent);
		int versionNumber = this.transcriptRepository.findMaxVersionNumber(meetingId) + 1;
		TranscriptEntity transcript = this.transcriptRepository.saveAndFlush(
				new TranscriptEntity(meetingId, versionNumber, sourceProcessingJobId, language));
		List<TranscriptSegmentEntity> savedSegments = this.segmentRepository.saveAll(segments.stream()
				.sorted(java.util.Comparator.comparingInt(TranscriptSegmentInput::sequenceNumber))
				.map(input -> new TranscriptSegmentEntity(transcript.getId(), input.sequenceNumber(), input.startMs(),
						input.endMs(), input.text().trim(), normalizeSpeaker(input.speakerLabel()), input.confidence()))
				.toList());
		this.segmentRepository.flush();
		return response(transcript, savedSegments);
	}

	@Transactional(readOnly = true)
	public TranscriptResponse getCurrent(UUID meetingId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		TranscriptEntity transcript = this.transcriptRepository.findByMeetingIdAndCurrentTrue(meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return response(transcript,
				this.segmentRepository.findAllByTranscriptIdOrderBySequenceNumberAsc(transcript.getId()));
	}

	@Transactional(readOnly = true)
	public TranscriptResponse get(UUID meetingId, UUID transcriptId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		TranscriptEntity transcript = transcript(meetingId, transcriptId);
		return response(transcript,
				this.segmentRepository.findAllByTranscriptIdOrderBySequenceNumberAsc(transcriptId));
	}

	@Transactional(readOnly = true)
	public Page<TranscriptVersionResponse> listVersions(UUID meetingId, UUID callerId, Pageable pageable) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		return this.transcriptRepository.findAllByMeetingId(meetingId, pageable).map(TranscriptVersionResponse::from);
	}

	public TranscriptSegmentUpdateResponse editSegment(UUID meetingId, UUID transcriptId, UUID segmentId,
			UUID callerId, String ifMatch, UpdateTranscriptSegmentRequest request) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		TranscriptEntity transcript = this.transcriptRepository.findByIdAndMeetingIdForUpdate(transcriptId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (parseEtag(ifMatch) != transcript.getConcurrencyVersion()) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		if (!transcript.isCurrent()) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		TranscriptSegmentEntity segment = this.segmentRepository.findByIdAndTranscriptId(segmentId, transcriptId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		String text = request.text().trim();
		String speakerLabel = normalizeSpeaker(request.speakerLabel());
		if (segment.getText().equals(text) && java.util.Objects.equals(segment.getSpeakerLabel(), speakerLabel)) {
			return TranscriptSegmentUpdateResponse.from(segment, transcript.getConcurrencyVersion());
		}
		int revisionNumber = this.revisionRepository.findMaxRevisionNumber(segmentId) + 1;
		this.revisionRepository.save(new TranscriptSegmentRevisionEntity(segmentId, revisionNumber, segment.getText(),
				text, segment.getSpeakerLabel(), speakerLabel, callerId));
		segment.correct(text, speakerLabel);
		transcript.touch();
		try {
			this.transcriptRepository.flush();
			this.segmentRepository.flush();
			this.revisionRepository.flush();
		}
		catch (ObjectOptimisticLockingFailureException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, exception);
		}
		return TranscriptSegmentUpdateResponse.from(segment, transcript.getConcurrencyVersion());
	}

	@Transactional(readOnly = true)
	public List<TranscriptSegmentRevisionResponse> revisions(UUID meetingId, UUID transcriptId, UUID segmentId,
			UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		transcript(meetingId, transcriptId);
		this.segmentRepository.findByIdAndTranscriptId(segmentId, transcriptId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return this.revisionRepository.findAllBySegmentIdOrderByRevisionNumberDesc(segmentId).stream()
				.map(TranscriptSegmentRevisionResponse::from).toList();
	}

	private TranscriptEntity transcript(UUID meetingId, UUID transcriptId) {
		return this.transcriptRepository.findByIdAndMeetingId(transcriptId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
	}

	@Override
	@Transactional(readOnly = true)
	public void requireEvidenceBelongsToTranscript(UUID meetingId, UUID transcriptId, List<UUID> segmentIds) {
		transcript(meetingId, transcriptId);
		Set<UUID> uniqueIds = new HashSet<>(segmentIds);
		if (uniqueIds.size() != segmentIds.size()
				|| uniqueIds.stream().anyMatch(id -> this.segmentRepository.findByIdAndTranscriptId(id, transcriptId).isEmpty())) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
	}

	private TranscriptResponse response(TranscriptEntity transcript, List<TranscriptSegmentEntity> segments) {
		return TranscriptResponse.from(transcript, segments.stream().map(TranscriptSegmentResponse::from).toList());
	}

	private static void validateIngestion(UUID sourceJobId, String language, List<TranscriptSegmentInput> segments) {
		if (sourceJobId == null || segments == null || segments.isEmpty() || (language != null && language.length() > 35)) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		Set<Integer> sequenceNumbers = new HashSet<>();
		for (TranscriptSegmentInput segment : segments) {
			if (segment == null || segment.sequenceNumber() < 1 || segment.startMs() < 0
					|| segment.endMs() <= segment.startMs() || segment.text() == null || segment.text().isBlank()
					|| segment.speakerLabel() != null && segment.speakerLabel().length() > 255
					|| segment.confidence() != null && (segment.confidence().signum() < 0
							|| segment.confidence().compareTo(java.math.BigDecimal.ONE) > 0)
					|| !sequenceNumbers.add(segment.sequenceNumber())) {
				throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
			}
		}
	}

	private static String normalizeSpeaker(String value) {
		return value == null || value.isBlank() ? null : value.trim();
	}

	private static long parseEtag(String ifMatch) {
		if (ifMatch == null || ifMatch.length() < 3 || ifMatch.charAt(0) != '"'
				|| ifMatch.charAt(ifMatch.length() - 1) != '"') {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		try {
			return Long.parseLong(ifMatch.substring(1, ifMatch.length() - 1));
		}
		catch (NumberFormatException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
	}

}
