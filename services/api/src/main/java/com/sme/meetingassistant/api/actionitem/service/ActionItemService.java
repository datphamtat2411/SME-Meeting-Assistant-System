package com.sme.meetingassistant.api.actionitem.service;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemChangeHistoryResponse;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemProposalInput;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemResponse;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import com.sme.meetingassistant.api.actionitem.dto.IngestActionItemsRequest;
import com.sme.meetingassistant.api.actionitem.dto.UpdateActionItemRequest;
import com.sme.meetingassistant.api.actionitem.entity.ActionItemChangeHistoryEntity;
import com.sme.meetingassistant.api.actionitem.entity.ActionItemEntity;
import com.sme.meetingassistant.api.actionitem.repository.ActionItemChangeHistoryRepository;
import com.sme.meetingassistant.api.actionitem.repository.ActionItemRepository;
import com.sme.meetingassistant.api.meeting.service.MeetingAccess;
import com.sme.meetingassistant.api.transcript.service.TranscriptEvidenceAccess;
import java.time.LocalDate;
import java.util.List;
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
public class ActionItemService implements ActionItemIngestion {

	private final MeetingAccess meetingAccess;
	private final TranscriptEvidenceAccess transcriptEvidenceAccess;
	private final ActionItemRepository actionItemRepository;
	private final ActionItemChangeHistoryRepository historyRepository;
	private final JdbcTemplate jdbcTemplate;

	public ActionItemService(MeetingAccess meetingAccess, TranscriptEvidenceAccess transcriptEvidenceAccess,
			ActionItemRepository actionItemRepository, ActionItemChangeHistoryRepository historyRepository,
			JdbcTemplate jdbcTemplate) {
		this.meetingAccess = meetingAccess;
		this.transcriptEvidenceAccess = transcriptEvidenceAccess;
		this.actionItemRepository = actionItemRepository;
		this.historyRepository = historyRepository;
		this.jdbcTemplate = jdbcTemplate;
	}

	@Override
	public List<ActionItemResponse> ingest(IngestActionItemsRequest request) {
		validateRequest(request);
		for (ActionItemProposalInput item : request.items()) {
			validateProposal(request, item);
		}
		return request.items().stream().map(item -> {
			ActionItemEntity entity = this.actionItemRepository.saveAndFlush(new ActionItemEntity(request.meetingId(),
					request.sourceTranscriptId(), item.title().trim(), item.suggestedAssigneeId(), item.dueDate()));
			for (UUID evidenceId : item.evidenceSegmentIds()) {
				this.jdbcTemplate.update("INSERT INTO action_item_evidence (action_item_id, transcript_segment_id) VALUES (?, ?)",
						entity.getId(), evidenceId);
			}
			return response(entity);
		}).toList();
	}

	@Transactional(readOnly = true)
	public Page<ActionItemResponse> list(UUID meetingId, UUID callerId, ActionItemStatus status, Pageable pageable) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		Page<ActionItemEntity> items = status == null ? this.actionItemRepository.findAllByMeetingId(meetingId, pageable)
				: this.actionItemRepository.findAllByMeetingIdAndStatus(meetingId, status, pageable);
		return items.map(this::response);
	}

	@Transactional(readOnly = true)
	public ActionItemResponse get(UUID meetingId, UUID actionItemId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		ActionItemEntity entity = this.actionItemRepository.findByIdAndMeetingId(actionItemId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return response(entity);
	}

	public ActionItemResponse update(UUID meetingId, UUID actionItemId, UUID callerId, String ifMatch,
			UpdateActionItemRequest request) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		if (request == null || request.isEmpty()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		ActionItemEntity entity = this.actionItemRepository.findByIdAndMeetingIdForUpdate(actionItemId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (parseEtag(ifMatch) != entity.getConcurrencyVersion()) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}

		ActionItemStatus previousStatus = entity.getStatus();
		UUID previousAssigneeId = entity.getAssigneeId();
		LocalDate previousDueDate = entity.getDueDate();
		ActionItemStatus nextStatus = request.status() == null ? previousStatus : request.status();
		UUID nextAssigneeId = request.assigneeId() == null ? previousAssigneeId : request.assigneeId();
		LocalDate nextDueDate = request.dueDate() == null ? previousDueDate : request.dueDate();
		validateTransition(previousStatus, nextStatus);
		if ((previousStatus.isTerminal() || nextStatus.isTerminal())
				&& (!java.util.Objects.equals(previousAssigneeId, nextAssigneeId)
						|| !java.util.Objects.equals(previousDueDate, nextDueDate))) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		if (request.assigneeId() != null) {
			this.meetingAccess.requireAssignee(meetingId, request.assigneeId());
		}
		if (nextStatus == ActionItemStatus.CONFIRMED && nextAssigneeId == null) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		boolean changed = previousStatus != nextStatus || !java.util.Objects.equals(previousAssigneeId, nextAssigneeId)
				|| !java.util.Objects.equals(previousDueDate, nextDueDate);
		if (!changed) {
			return response(entity);
		}

		entity.setStatus(nextStatus);
		entity.setAssigneeId(nextAssigneeId);
		entity.setDueDate(nextDueDate);
		this.historyRepository.save(new ActionItemChangeHistoryEntity(entity.getId(), previousStatus, nextStatus,
				previousAssigneeId, nextAssigneeId, previousDueDate, nextDueDate, callerId));
		try {
			this.actionItemRepository.flush();
			this.historyRepository.flush();
		}
		catch (ObjectOptimisticLockingFailureException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, exception);
		}
		return response(entity);
	}

	@Transactional(readOnly = true)
	public List<ActionItemChangeHistoryResponse> history(UUID meetingId, UUID actionItemId, UUID callerId) {
		this.meetingAccess.requireAccessible(meetingId, callerId);
		this.actionItemRepository.findByIdAndMeetingId(actionItemId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		return this.historyRepository.findAllByActionItemIdOrderByCreatedAtDescIdDesc(actionItemId).stream()
				.map(ActionItemChangeHistoryResponse::from).toList();
	}

	private void validateProposal(IngestActionItemsRequest request, ActionItemProposalInput item) {
		if (item == null || item.title() == null || item.title().isBlank() || item.title().length() > 500
				|| item.evidenceSegmentIds() == null || item.evidenceSegmentIds().isEmpty()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		this.transcriptEvidenceAccess.requireEvidenceBelongsToTranscript(request.meetingId(), request.sourceTranscriptId(),
				item.evidenceSegmentIds());
		if (item.suggestedAssigneeId() != null) {
			this.meetingAccess.requireAssignee(request.meetingId(), item.suggestedAssigneeId());
		}
	}

	private ActionItemResponse response(ActionItemEntity entity) {
		List<UUID> evidenceIds = this.jdbcTemplate.query("SELECT transcript_segment_id FROM action_item_evidence "
				+ "WHERE action_item_id = ? ORDER BY transcript_segment_id", (resultSet, row) -> resultSet.getObject(1, UUID.class),
				entity.getId());
		return ActionItemResponse.from(entity, evidenceIds, LocalDate.now());
	}

	private static void validateRequest(IngestActionItemsRequest request) {
		if (request == null || request.meetingId() == null || request.sourceTranscriptId() == null
				|| request.items() == null || request.items().isEmpty()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
	}

	private static void validateTransition(ActionItemStatus current, ActionItemStatus next) {
		if (current == next) {
			return;
		}
		boolean allowed = switch (current) {
			case PROPOSED -> next == ActionItemStatus.CONFIRMED || next == ActionItemStatus.CANCELLED;
			case CONFIRMED -> next == ActionItemStatus.IN_PROGRESS || next == ActionItemStatus.COMPLETED
					|| next == ActionItemStatus.CANCELLED;
			case IN_PROGRESS -> next == ActionItemStatus.COMPLETED || next == ActionItemStatus.CANCELLED;
			case COMPLETED, CANCELLED -> false;
		};
		if (!allowed) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
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
