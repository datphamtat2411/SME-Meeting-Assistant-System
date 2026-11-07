package com.sme.meetingassistant.api.actionitems;

import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
@RequestMapping("/api/v1/action-items")
public class ActionItemController {
    private static final java.util.Set<String> SORT_FIELDS = java.util.Set.of("createdAt", "dueDate", "status", "title");
    private final ActionItemService service;
    private final ApiResponseFactory responses;
    private final AuthenticatedUserId caller;

    public ActionItemController(ActionItemService service, ApiResponseFactory responses, AuthenticatedUserId caller) {
        this.service = service;
        this.responses = responses;
        this.caller = caller;
    }

    @GetMapping
    public ApiResponse<List<ActionItemView>> list(@RequestParam(required=false) UUID meetingId,
            @RequestParam(required=false) ActionItemStatus status,
            @RequestParam(required=false) @Size(max=200) String q,
            @RequestParam(required=false) @Size(max=64) String assignee,
            @RequestParam(required=false) Boolean overdue,
            @RequestParam(defaultValue="0") @Min(0) int page,
            @RequestParam(defaultValue="20") @Min(1) @Max(100) int size,
            @RequestParam(defaultValue="createdAt,desc") String sort) {
        String[] parts = sort.split(",", -1);
        if (parts.length != 2 || !SORT_FIELDS.contains(parts[0])) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        Sort.Direction direction;
        try { direction = Sort.Direction.fromString(parts[1]); }
        catch (IllegalArgumentException bad) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST); }
        return responses.successPage(service.list(caller.requireUserId(), meetingId, status, q, assignee, overdue,
            PageRequest.of(page, size, Sort.by(direction, parts[0]))));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<ActionItemView>> create(@Valid @RequestBody CreateActionItemRequest request) {
        ActionItemView item = service.createManual(caller.requireUserId(), request);
        return ResponseEntity.created(URI.create("/api/v1/action-items/" + item.id()))
            .header(HttpHeaders.ETAG, ActionItemEtags.of(item)).body(responses.success(item));
    }

    @GetMapping("/{actionItemId}")
    public ResponseEntity<ApiResponse<ActionItemView>> detail(@PathVariable UUID actionItemId) {
        ActionItemView item = service.detail(actionItemId, caller.requireUserId());
        return result(item);
    }

    @PatchMapping("/{actionItemId}")
    public ResponseEntity<ApiResponse<ActionItemView>> update(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String ifMatch,
            @RequestBody Map<String,Object> patch) {
        return result(service.update(actionItemId, caller.requireUserId(), ifMatch, patch));
    }

    @PostMapping("/{actionItemId}/confirm")
    public ResponseEntity<ApiResponse<ActionItemView>> confirm(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.confirm(actionItemId, caller.requireUserId(), tag));
    }
    @PostMapping("/{actionItemId}/reject")
    public ResponseEntity<ApiResponse<ActionItemView>> reject(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.reject(actionItemId, caller.requireUserId(), tag));
    }
    @PostMapping("/{actionItemId}/start")
    public ResponseEntity<ApiResponse<ActionItemView>> start(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.start(actionItemId, caller.requireUserId(), tag));
    }
    @PostMapping("/{actionItemId}/complete")
    public ResponseEntity<ApiResponse<ActionItemView>> complete(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.complete(actionItemId, caller.requireUserId(), tag));
    }
    @PostMapping("/{actionItemId}/cancel")
    public ResponseEntity<ApiResponse<ActionItemView>> cancel(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.cancel(actionItemId, caller.requireUserId(), tag));
    }
    @PostMapping("/{actionItemId}/reopen")
    public ResponseEntity<ApiResponse<ActionItemView>> reopen(@PathVariable UUID actionItemId,
            @RequestHeader(value=HttpHeaders.IF_MATCH, required=false) String tag) {
        return result(service.reopen(actionItemId, caller.requireUserId(), tag));
    }

    private ResponseEntity<ApiResponse<ActionItemView>> result(ActionItemView item) {
        return ResponseEntity.ok().header(HttpHeaders.ETAG, ActionItemEtags.of(item)).body(responses.success(item));
    }
}
