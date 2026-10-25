package com.sme.meetingassistant.api.notification.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.common.PaginationMeta;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import com.sme.meetingassistant.api.notification.dto.MarkAllReadResponse;
import com.sme.meetingassistant.api.notification.dto.NotificationResponse;
import com.sme.meetingassistant.api.notification.dto.UnreadCountResponse;
import com.sme.meetingassistant.api.notification.service.NotificationService;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

	private final NotificationService notificationService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public NotificationController(NotificationService notificationService, ApiResponseFactory responseFactory,
			CallerContextResolver callerContextResolver) {
		this.notificationService = notificationService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@GetMapping
	public ApiResponse<List<NotificationResponse>> list(
			@RequestParam(defaultValue = "false") boolean unreadOnly,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size, Principal principal) {
		Page<NotificationResponse> notifications = this.notificationService.list(callerId(principal), unreadOnly,
				PageRequest.of(page, size, Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id"))));
		return this.responseFactory.success(notifications.getContent(), new PaginationMeta(notifications.getNumber(),
				notifications.getSize(), notifications.getTotalElements(), notifications.getTotalPages()));
	}

	@GetMapping("/unread-count")
	public ApiResponse<UnreadCountResponse> unreadCount(Principal principal) {
		return this.responseFactory.success(new UnreadCountResponse(this.notificationService.unreadCount(callerId(principal))));
	}

	@PatchMapping("/{notificationId}/read")
	public ResponseEntity<ApiResponse<NotificationResponse>> markRead(@PathVariable UUID notificationId,
			@RequestHeader(name = HttpHeaders.IF_MATCH, required = false) String ifMatch, Principal principal) {
		NotificationResponse notification = this.notificationService.markRead(notificationId, callerId(principal), ifMatch);
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(notification.concurrencyVersion()))
				.body(this.responseFactory.success(notification));
	}

	@PostMapping("/read-all")
	public ApiResponse<MarkAllReadResponse> markAllRead(Principal principal) {
		return this.responseFactory.success(this.notificationService.markAllRead(callerId(principal)));
	}

	private UUID callerId(Principal principal) {
		return this.callerContextResolver.resolve(principal).userId();
	}

	private static String etag(long version) { return "\"" + version + "\""; }

}
