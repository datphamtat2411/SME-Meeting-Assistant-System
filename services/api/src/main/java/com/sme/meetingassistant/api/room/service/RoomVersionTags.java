package com.sme.meetingassistant.api.room.service;

import com.sme.meetingassistant.api.room.entity.RoomEntity;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Opaque per-resource HTTP preconditions. */
public final class RoomVersionTags {
    private RoomVersionTags() { }

    public static String of(RoomEntity room) {
        return "\"r-" + room.getId() + "-" + room.getVersion() + "\"";
    }

    public static void requireMatch(RoomEntity room, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        if (!of(room).equals(ifMatch)) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
