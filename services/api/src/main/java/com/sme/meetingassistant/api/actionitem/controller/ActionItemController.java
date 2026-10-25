package com.sme.meetingassistant.api.actionitem.controller;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemChangeHistoryResponse;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemResponse;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import com.sme.meetingassistant.api.actionitem.dto.UpdateActionItemRequest;
import com.sme.meetingassistant.api.actionitem.service.ActionItemService;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.common.PaginationMeta;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import jakarta.validation.Valid;
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
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/action-items")
public class ActionItemController {

	private final ActionItemService actionItemService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public ActionItemController(ActionItemService actionItemService, ApiResponseFactory responseFactory,
			CallerContextResolver callerContextResolver) {
		this.actionItemService = actionItemService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@GetMapping
	public ApiResponse<List<ActionItemResponse>> list(@PathVariable UUID meetingId,
			@RequestParam(required = false) ActionItemStatus status,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size, Principal principal) {
		Page<ActionItemResponse> items = this.actionItemService.list(meetingId, callerId(principal), status,
				PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "createdAt")));
		return this.responseFactory.success(items.getContent(), pagination(items));
	}

	@GetMapping("/{actionItemId}")
	public ResponseEntity<ApiResponse<ActionItemResponse>> get(@PathVariable UUID meetingId,
			@PathVariable UUID actionItemId, Principal principal) {
		ActionItemResponse item = this.actionItemService.get(meetingId, actionItemId, callerId(principal));
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(item.concurrencyVersion()))
				.body(this.responseFactory.success(item));
	}

	@PatchMapping("/{actionItemId}")
	public ResponseEntity<ApiResponse<ActionItemResponse>> update(@PathVariable UUID meetingId,
			@PathVariable UUID actionItemId,
			@RequestHeader(name = HttpHeaders.IF_MATCH, required = false) String ifMatch,
			@Valid @RequestBody UpdateActionItemRequest request, Principal principal) {
		ActionItemResponse item = this.actionItemService.update(meetingId, actionItemId, callerId(principal), ifMatch,
				request);
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(item.concurrencyVersion()))
				.body(this.responseFactory.success(item));
	}

	@GetMapping("/{actionItemId}/history")
	public ApiResponse<List<ActionItemChangeHistoryResponse>> history(@PathVariable UUID meetingId,
			@PathVariable UUID actionItemId, Principal principal) {
		return this.responseFactory.success(this.actionItemService.history(meetingId, actionItemId, callerId(principal)));
	}

	private UUID callerId(Principal principal) {
		return this.callerContextResolver.resolve(principal).userId();
	}

	private static PaginationMeta pagination(Page<?> page) {
		return new PaginationMeta(page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
	}

	private static String etag(long version) { return "\"" + version + "\""; }

}
