package com.sme.meetingassistant.api.meeting.idempotency;

import com.sme.meetingassistant.api.meeting.dto.CreateMeetingRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/**
 * PostgreSQL is the concurrency authority for retry-safe POST /api/v1/meetings.
 * A unique (actor,key-hash) claim is acquired before creation, in the SAME
 * transaction as the canonical meeting, memberships and successful audit.
 * Another API instance using the same key waits for the first commit/rollback.
 */
@Service
public class MeetingCreationIdempotencyService {
    private static final Pattern VALID_KEY =
        Pattern.compile("[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}");
    private static final String CREATE_OPERATION = "POST /api/v1/meetings";
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public MeetingCreationIdempotencyService(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /**
     * null => new claim owned by this transaction; UUID => committed replay.
     * Missing key is supported at the controller/service boundary and never
     * calls this method.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public UUID claimOrReplay(UUID actorId, String key, CreateMeetingRequest request) {
        if (actorId == null || request == null || key == null || !VALID_KEY.matcher(key).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Idempotency-Key");
        }
        String keyDigest = sha256(CREATE_OPERATION + "\n" + key);
        String requestDigest = fingerprint(request);

        // Reclaim only the expired record for this exact caller and key.
        // The unique constraint remains the authority under concurrent retries.
        jdbc.update("""
            DELETE FROM meeting_creation_idempotency
             WHERE actor_user_id=? AND key_digest=? AND expires_at <= clock_timestamp()
            """, actorId, keyDigest);

        int inserted = jdbc.update("""
            INSERT INTO meeting_creation_idempotency
              (actor_user_id, key_digest, request_digest, expires_at)
            VALUES (?, ?, ?, clock_timestamp() + INTERVAL '24 hours')
            ON CONFLICT (actor_user_id, key_digest) DO NOTHING
            """, actorId, keyDigest, requestDigest);
        if (inserted == 1) return null;

        List<Claim> existing = jdbc.query("""
            SELECT request_digest, meeting_id
              FROM meeting_creation_idempotency
             WHERE actor_user_id=? AND key_digest=?
            """, (rs, i) -> new Claim(rs.getString("request_digest").trim(),
                rs.getObject("meeting_id", UUID.class)), actorId, keyDigest);
        if (existing.size() != 1) {
            throw new IllegalStateException("Idempotency record missing after uniqueness conflict");
        }
        Claim stored = existing.getFirst();
        if (!stored.requestDigest().equals(requestDigest)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Idempotency-Key is already bound to a different meeting creation intent");
        }
        if (stored.meetingId() == null) {
            throw new IllegalStateException("An incomplete idempotency record became visible");
        }
        return stored.meetingId();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void complete(UUID actorId, String key, UUID meetingId) {
        if (jdbc.update("""
            UPDATE meeting_creation_idempotency SET meeting_id=?
             WHERE actor_user_id=? AND key_digest=? AND meeting_id IS NULL
            """, meetingId, actorId, sha256(CREATE_OPERATION + "\n" + key)) != 1) {
            throw new IllegalStateException("Meeting creation idempotency claim could not be completed");
        }
    }

    /**
     * Small bounded maintenance batch; expiry does not require background work
     * to make a reused key eligible. SKIP LOCKED avoids active creation claims.
     */
    @Scheduled(fixedDelayString = "${app.meeting.idempotency.cleanup-delay-ms:3600000}")
    public void removeExpired() {
        jdbc.update("""
            DELETE FROM meeting_creation_idempotency target
             USING (
                SELECT actor_user_id, key_digest
                  FROM meeting_creation_idempotency
                 WHERE expires_at <= clock_timestamp()
                 ORDER BY expires_at
                 LIMIT 500 FOR UPDATE SKIP LOCKED
             ) expired
             WHERE target.actor_user_id=expired.actor_user_id
               AND target.key_digest=expired.key_digest
            """);
    }

    private String fingerprint(CreateMeetingRequest request) {
        List<String> participants = new ArrayList<>();
        if (request.participantUserIds() != null) {
            for (UUID id : request.participantUserIds()) {
                participants.add(id == null ? null : id.toString());
            }
        }
        participants.sort(Comparator.nullsFirst(Comparator.naturalOrder()));
        // Stable, explicit field order. Normalize harmless formatting, offsets,
        // absent/empty participant list and participant order; preserve duplicates.
        List<Object> canonical = Arrays.asList(
            request.title() == null ? null : request.title().trim(),
            optional(request.description()),
            instant(request.scheduledStartAt()),
            instant(request.scheduledEndAt()),
            request.roomId() == null ? null : request.roomId().toString(),
            participants
        );
        return sha256(json.writeValueAsString(canonical));
    }

    private static String optional(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static String instant(OffsetDateTime time) {
        return time == null ? null : time.toInstant().toString();
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private record Claim(String requestDigest, UUID meetingId) { }
}
