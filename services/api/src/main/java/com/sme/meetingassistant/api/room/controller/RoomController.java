package com.sme.meetingassistant.api.room.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.room.dto.CreateRoomRequest;
import com.sme.meetingassistant.api.room.dto.RoomView;
import com.sme.meetingassistant.api.room.entity.RoomEntity;
import com.sme.meetingassistant.api.room.entity.RoomStatus;
import com.sme.meetingassistant.api.room.service.RoomCatalogService;
import com.sme.meetingassistant.api.room.service.RoomVersionTags;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@Validated
@RequestMapping("/api/v1/rooms")
public class RoomController {
    private static final Set<String> SORT_FIELDS =
        Set.of("code", "name", "capacity", "status", "createdAt");
    private final RoomCatalogService service;
    private final ApiResponseFactory responses;

    public RoomController(RoomCatalogService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @GetMapping
    public ApiResponse<List<RoomView>> list(
            @RequestParam(required = false) @Size(max = 200) String q,
            @RequestParam(required = false) RoomStatus status,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
            @RequestParam(defaultValue = "code,asc") String sort) {
        String[] parts = sort.split(",", -1);
        if (parts.length != 2 || !SORT_FIELDS.contains(parts[0])) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        }
        Sort.Direction direction;
        try {
            direction = Sort.Direction.fromString(parts[1]);
        } catch (IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        }
        Sort order = Sort.by(direction, parts[0]).and(Sort.by("id"));
        return responses.successPage(service.list(q, status, PageRequest.of(page, size, order)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<RoomView>> create(@Valid @RequestBody CreateRoomRequest request) {
        RoomEntity created = service.create(request);
        return ResponseEntity.created(URI.create("/api/v1/rooms/" + created.getId()))
            .header(HttpHeaders.ETAG, RoomVersionTags.of(created))
            .body(responses.success(RoomCatalogService.view(created)));
    }

    @GetMapping("/{roomId}")
    public ResponseEntity<ApiResponse<RoomView>> get(@PathVariable UUID roomId) {
        RoomEntity room = service.get(roomId);
        return ResponseEntity.ok().header(HttpHeaders.ETAG, RoomVersionTags.of(room))
            .body(responses.success(RoomCatalogService.view(room)));
    }

    @PatchMapping("/{roomId}")
    public ResponseEntity<ApiResponse<RoomView>> update(
            @PathVariable UUID roomId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @RequestBody java.util.Map<String, Object> patch) {
        RoomEntity room = service.update(roomId, ifMatch, patch);
        return ResponseEntity.ok().header(HttpHeaders.ETAG, RoomVersionTags.of(room))
            .body(responses.success(RoomCatalogService.view(room)));
    }

    @PostMapping("/{roomId}/deactivate")
    public ResponseEntity<ApiResponse<RoomView>> deactivate(
            @PathVariable UUID roomId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch) {
        RoomEntity room = service.deactivate(roomId, ifMatch);
        return ResponseEntity.ok().header(HttpHeaders.ETAG, RoomVersionTags.of(room))
            .body(responses.success(RoomCatalogService.view(room)));
    }
}
