package com.sme.meetingassistant.api.notification.service;

import com.sme.meetingassistant.api.notification.dto.CreateNotificationCommand;
import com.sme.meetingassistant.api.notification.dto.MarkAllReadResponse;
import com.sme.meetingassistant.api.notification.dto.NotificationResponse;
import com.sme.meetingassistant.api.notification.entity.NotificationEntity;
import com.sme.meetingassistant.api.notification.repository.NotificationRepository;
import java.util.regex.Pattern;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class NotificationService implements NotificationCommand {

	private static final Pattern TYPE_PATTERN = Pattern.compile("^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$");
	private final NotificationRepository notificationRepository;
	private final JdbcTemplate jdbcTemplate;

	public NotificationService(NotificationRepository notificationRepository, JdbcTemplate jdbcTemplate) {
		this.notificationRepository = notificationRepository;
		this.jdbcTemplate = jdbcTemplate;
	}

	@Override
	public NotificationResponse create(CreateNotificationCommand command) {
		validate(command);
		this.jdbcTemplate.update("""
				INSERT INTO notifications (event_id, recipient_id, type, title, body, resource_type, resource_id)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (event_id, recipient_id) DO NOTHING
				""", command.eventId(), command.recipientId(), command.type(), command.title().trim(), command.body().trim(),
				command.resourceType(), command.resourceId());
		NotificationEntity notification = this.notificationRepository
				.findByEventIdAndRecipientId(command.eventId(), command.recipientId())
				.orElseThrow(() -> new IllegalStateException("Notification insert did not produce a row."));
		return NotificationResponse.from(notification);
	}

	@Transactional(readOnly = true)
	public Page<NotificationResponse> list(UUID recipientId, boolean unreadOnly, Pageable pageable) {
		Page<NotificationEntity> notifications = unreadOnly
				? this.notificationRepository.findAllByRecipientIdAndReadAtIsNull(recipientId, pageable)
				: this.notificationRepository.findAllByRecipientId(recipientId, pageable);
		return notifications.map(NotificationResponse::from);
	}

	@Transactional(readOnly = true)
	public long unreadCount(UUID recipientId) {
		return this.notificationRepository.countByRecipientIdAndReadAtIsNull(recipientId);
	}

	public NotificationResponse markRead(UUID notificationId, UUID recipientId, String ifMatch) {
		NotificationEntity notification = this.notificationRepository.findByIdAndRecipientIdForUpdate(notificationId,
				recipientId).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (parseEtag(ifMatch) != notification.getConcurrencyVersion()) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		if (notification.getReadAt() == null) {
			notification.markRead();
			notification = this.notificationRepository.saveAndFlush(notification);
		}
		return NotificationResponse.from(notification);
	}

	public MarkAllReadResponse markAllRead(UUID recipientId) {
		return new MarkAllReadResponse(this.notificationRepository.markAllUnreadRead(recipientId));
	}

	private static void validate(CreateNotificationCommand command) {
		if (command == null || command.eventId() == null || command.recipientId() == null || command.type() == null
				|| command.type().length() > 100 || !TYPE_PATTERN.matcher(command.type()).matches()
				|| command.title() == null || command.title().isBlank() || command.title().length() > 255
				|| command.body() == null || command.body().isBlank() || command.body().length() > 5000
				|| (command.resourceType() == null) != (command.resourceId() == null)
				|| command.resourceType() != null && (command.resourceType().isBlank()
						|| command.resourceType().length() > 100)) {
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
