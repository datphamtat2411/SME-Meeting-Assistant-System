package com.sme.meetingassistant.api.room.service;

import com.sme.meetingassistant.api.room.dto.CreateRoomRequest;
import com.sme.meetingassistant.api.room.dto.RoomView;
import com.sme.meetingassistant.api.room.entity.RoomEntity;
import com.sme.meetingassistant.api.room.entity.RoomStatus;
import com.sme.meetingassistant.api.room.repository.RoomRepository;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class RoomCatalogService {
    private static final Set<String> EDITABLE_FIELDS = Set.of("name", "location", "capacity", "notes");

    private final RoomRepository rooms;
    private final OrganizationalAuthorizationService authorization;

    public RoomCatalogService(RoomRepository rooms, OrganizationalAuthorizationService authorization) {
        this.rooms = rooms;
        this.authorization = authorization;
    }

    public RoomEntity create(CreateRoomRequest request) {
        authorization.requireAdministrator();
        String code = required(required(request.code(), 64).toUpperCase(Locale.ROOT), 64);
        if (rooms.existsByCode(code)) throw conflict();
        RoomEntity room = new RoomEntity(code, required(request.name(), 160),
            optional(request.location(), 255), request.capacity(), optional(request.notes(), 0));
        try {
            return rooms.saveAndFlush(room);
        } catch (DataIntegrityViolationException duplicate) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicate);
        }
    }

    @Transactional(readOnly = true)
    public Page<RoomView> list(String query, RoomStatus status, Pageable pageable) {
        var actor = authorization.requireActiveActor();
        boolean admin = actor.getGlobalRole() == GlobalRole.ADMINISTRATOR;
        if (status == RoomStatus.INACTIVE && !admin) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        RoomStatus effectiveStatus = admin ? status : RoomStatus.ACTIVE;
        Specification<RoomEntity> spec = (root, ignored, cb) -> {
            var predicate = effectiveStatus == null
                ? cb.conjunction() : cb.equal(root.get("status"), effectiveStatus);
            if (query == null || query.isBlank()) return predicate;
            String pattern = "%" + query.trim().toLowerCase(Locale.ROOT)
                .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
            return cb.and(predicate, cb.or(
                cb.like(cb.lower(root.get("code")), pattern, '\\'),
                cb.like(cb.lower(root.get("name")), pattern, '\\'),
                cb.like(cb.lower(root.get("location")), pattern, '\\')));
        };
        return rooms.findAll(spec, pageable).map(RoomCatalogService::view);
    }

    @Transactional(readOnly = true)
    public RoomEntity get(UUID id) {
        authorization.requireActiveActor();
        // Inactive rooms remain visible as historical resource metadata.
        return find(id);
    }

    public RoomEntity update(UUID id, String ifMatch, Map<String, Object> patch) {
        authorization.requireAdministrator();
        RoomEntity room = find(id);
        RoomVersionTags.requireMatch(room, ifMatch);
        if (room.getStatus() != RoomStatus.ACTIVE) throw conflict();
        if (patch == null || patch.isEmpty() || !EDITABLE_FIELDS.containsAll(patch.keySet())) {
            throw invalid();
        }
        String name = room.getName();
        String location = room.getLocation();
        Integer capacity = room.getCapacity();
        String notes = room.getNotes();
        for (var entry : patch.entrySet()) {
            Object value = entry.getValue();
            switch (entry.getKey()) {
                case "name" -> name = required(asString(value), 160);
                case "location" -> location = optional(asString(value), 255);
                case "notes" -> notes = optional(asString(value), 0);
                case "capacity" -> {
                    if (value != null && (!(value instanceof Integer n) || n <= 0)) throw invalid();
                    capacity = (Integer) value;
                }
                default -> throw invalid();
            }
        }
        room.updateMetadata(name, location, capacity, notes);
        return flush(room);
    }

    public RoomEntity deactivate(UUID id, String ifMatch) {
        authorization.requireAdministrator();
        RoomEntity room = find(id);
        RoomVersionTags.requireMatch(room, ifMatch);
        if (room.getStatus() != RoomStatus.ACTIVE) throw conflict();
        // No reservation data exists in T01. Later waves must preserve history and
        // define treatment of future reservations without introducing hard-delete.
        room.deactivate();
        return flush(room);
    }

    private RoomEntity flush(RoomEntity room) {
        try {
            return rooms.saveAndFlush(room);
        } catch (ObjectOptimisticLockingFailureException stale) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, stale);
        }
    }

    private RoomEntity find(UUID id) {
        return rooms.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    private static String asString(Object value) {
        if (value == null) return null;
        if (!(value instanceof String s)) throw invalid();
        return s;
    }

    private static String required(String value, int maxLength) {
        if (value == null || value.isBlank()) throw invalid();
        String normalized = value.trim();
        if (normalized.length() > maxLength) throw invalid();
        return normalized;
    }

    private static String optional(String value, int maxLength) {
        if (value == null || value.isBlank()) return null;
        String normalized = value.trim();
        if (maxLength > 0 && normalized.length() > maxLength) throw invalid();
        return normalized;
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    private static ResponseStatusException conflict() {
        return new ResponseStatusException(HttpStatus.CONFLICT);
    }

    public static RoomView view(RoomEntity r) {
        return new RoomView(r.getId(), r.getCode(), r.getName(), r.getLocation(),
            r.getCapacity(), r.getStatus(), r.getNotes(), r.getCreatedAt(), r.getUpdatedAt());
    }
}
