package com.sme.meetingassistant.api.intelligence.service;

import com.sme.meetingassistant.api.intelligence.dto.DecisionProposalInput;
import com.sme.meetingassistant.api.intelligence.dto.IngestMeetingIntelligenceRequest;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionResponse;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatus;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatusHistoryResponse;
import com.sme.meetingassistant.api.intelligence.dto.MeetingSummaryResponse;
import com.sme.meetingassistant.api.intelligence.dto.UpdateDecisionStatusRequest;
import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionEntity;
import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionStatusHistoryEntity;
import com.sme.meetingassistant.api.intelligence.entity.MeetingSummaryEntity;
import com.sme.meetingassistant.api.intelligence.repository.MeetingDecisionRepository;
import com.sme.meetingassistant.api.intelligence.repository.MeetingDecisionStatusHistoryRepository;
import com.sme.meetingassistant.api.intelligence.repository.MeetingSummaryRepository;
import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptSegmentRepository;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class MeetingIntelligenceService implements MeetingIntelligenceIngestion {

	private final MeetingAccess meetingAccess;
	private final MeetingSummaryRepository summaryRepository;
	private final MeetingDecisionRepository decisionRepository;
	private final MeetingDecisionStatusHistoryRepository historyRepository;
	private final TranscriptRepository transcriptRepository;
	private final TranscriptSegmentRepository segmentRepository;
	private final JdbcTemplate jdbcTemplate;

	public MeetingIntelligenceService(MeetingAccess meetingAccess, MeetingSummaryRepository summaryRepository,
			MeetingDecisionRepository decisionRepository,
			MeetingDecisionStatusHistoryRepository historyRepository, TranscriptRepository transcriptRepository,
			TranscriptSegmentRepository segmentRepository, JdbcTemplate jdbcTemplate) {
		this.meetingAccess = meetingAccess;
		this.summaryRepository = summaryRepository;
		this.decisionRepository = decisionRepository;
		this.historyRepository = historyRepository;
		this.transcriptRepository = transcriptRepository;
		this.segmentRepository = segmentRepository;
		this.jdbcTemplate = jdbcTemplate;
	}

	@Override
	public MeetingSummaryResponse ingest(IngestMeetingIntelligenceRequest request) {
		validateRequest(request);
		var transcript = this.transcriptRepository.findByIdAndMeetingId(request.sourceTranscriptId(), request.meetingId())
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		Set<UUID> transcriptSegmentIds = this.segmentRepository
				.findAllByTranscriptIdOrderBySequenceNumberAsc(transcript.getId()).stream()
				.map(segment -> segment.getId()).collect(java.util.stream.Collectors.toSet());
		for (DecisionProposalInput proposal : request.decisions()) {
			validateProposal(proposal, transcriptSegmentIds);
		}

		this.summaryRepository.findCurrentForUpdate(request.meetingId()).ifPresent(MeetingSummaryEntity::markNotCurrent);
		this.summaryRepository.flush();
		int versionNumber = this.summaryRepository.findMaxVersionNumber(request.meetingId()) + 1;
		MeetingSummaryEntity summary = this.summaryRepository.saveAndFlush(new MeetingSummaryEntity(request.meetingId(),
				request.sourceTranscriptId(), versionNumber, request.title().trim(), request.overview().trim(),
				request.keyPoints().stream().map(String::trim).toList()));
		for (DecisionProposalInput proposal : request.decisions()) {
			MeetingDecisionEntity decision = this.decisionRepository.saveAndFlush(new MeetingDecisionEntity(
					request.meetingId(), summary.getId(), proposal.statement().trim(), proposal.confidence()));
			for (UUID evidenceId : proposal.evidenceSegmentIds()) {
				this.jdbcTemplate.update("INSERT INTO meeting_decision_evidence (decision_id, transcript_segment_id) VALUES (?, ?)",
						decision.getId(), evidenceId);
			}
		}
		return summaryResponse(summary);
	}

	@Transactional(readOnly = true)
	public MeetingSummaryResponse getCurrentSummary(UUID meetingId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		MeetingSummaryEntity summary = this.summaryRepository.findByMeetingIdAndCurrentTrue(meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return summaryResponse(summary);
	}

	@Transactional(readOnly = true)
	public Page<MeetingSummaryResponse> listSummaries(UUID meetingId, UUID callerId, Pageable pageable) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		return this.summaryRepository.findAllByMeetingId(meetingId, pageable).map(this::summaryResponse);
	}

	@Transactional(readOnly = true)
	public Page<MeetingDecisionResponse> listDecisions(UUID meetingId, UUID callerId, Pageable pageable) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		return this.decisionRepository.findAllByMeetingId(meetingId, pageable).map(this::decisionResponse);
	}

	public MeetingDecisionResponse reviewDecision(UUID meetingId, UUID decisionId, UUID callerId, String ifMatch,
			UpdateDecisionStatusRequest request) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		MeetingDecisionEntity decision = this.decisionRepository.findByIdAndMeetingIdForUpdate(decisionId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (parseEtag(ifMatch) != decision.getConcurrencyVersion()) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		if (decision.getStatus() == request.status()) {
			return decisionResponse(decision);
		}
		MeetingDecisionStatus previousStatus = decision.getStatus();
		decision.setStatus(request.status());
		this.historyRepository.save(new MeetingDecisionStatusHistoryEntity(decision.getId(), previousStatus,
				request.status(), callerId));
		try {
			this.decisionRepository.flush();
			this.historyRepository.flush();
		}
		catch (ObjectOptimisticLockingFailureException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, exception);
		}
		return decisionResponse(decision);
	}

	@Transactional(readOnly = true)
	public List<MeetingDecisionStatusHistoryResponse> decisionHistory(UUID meetingId, UUID decisionId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		this.decisionRepository.findByIdAndMeetingId(decisionId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return this.historyRepository.findAllByDecisionIdOrderByCreatedAtDescIdDesc(decisionId).stream()
				.map(MeetingDecisionStatusHistoryResponse::from).toList();
	}

	private MeetingSummaryResponse summaryResponse(MeetingSummaryEntity summary) {
		List<MeetingDecisionResponse> decisions = this.decisionRepository
				.findAllBySummaryIdOrderByCreatedAtAsc(summary.getId()).stream().map(this::decisionResponse).toList();
		return MeetingSummaryResponse.from(summary, decisions);
	}

	private MeetingDecisionResponse decisionResponse(MeetingDecisionEntity decision) {
		List<UUID> evidenceIds = this.jdbcTemplate.query("SELECT transcript_segment_id FROM meeting_decision_evidence "
				+ "WHERE decision_id = ? ORDER BY transcript_segment_id", (resultSet, row) -> resultSet.getObject(1, UUID.class),
				decision.getId());
		return MeetingDecisionResponse.from(decision, evidenceIds);
	}

	private static void validateRequest(IngestMeetingIntelligenceRequest request) {
		if (request == null || request.meetingId() == null || request.sourceTranscriptId() == null
				|| request.title() == null || request.title().isBlank() || request.title().length() > 255
				|| request.overview() == null || request.overview().isBlank() || request.keyPoints() == null
				|| request.keyPoints().stream().anyMatch(point -> point == null || point.isBlank())
				|| request.decisions() == null) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
	}

	private static void validateProposal(DecisionProposalInput proposal, Set<UUID> transcriptSegmentIds) {
		if (proposal == null || proposal.statement() == null || proposal.statement().isBlank()
				|| proposal.evidenceSegmentIds() == null || proposal.evidenceSegmentIds().isEmpty()
				|| proposal.confidence() != null && (proposal.confidence().signum() < 0
						|| proposal.confidence().compareTo(java.math.BigDecimal.ONE) > 0)) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		Set<UUID> uniqueIds = new HashSet<>(proposal.evidenceSegmentIds());
		if (uniqueIds.size() != proposal.evidenceSegmentIds().size()
				|| !transcriptSegmentIds.containsAll(uniqueIds)) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
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
