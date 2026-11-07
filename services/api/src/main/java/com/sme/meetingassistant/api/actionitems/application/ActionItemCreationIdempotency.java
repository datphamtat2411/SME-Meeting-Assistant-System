package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/**
 * Transactional create-once token for POST /api/v1/action-items.
 * The DB uniqueness constraint arbitrates concurrent HTTP retries across nodes;
 * no local cache, early commit, or separately committed receipt is permitted.
 */
@Service
public class ActionItemCreationIdempotency {
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}");
    private static final String OP = "POST /api/v1/action-items";
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public ActionItemCreationIdempotency(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID claimOrReplay(UUID actor, String key, CreateActionItemRequest request) {
        if (actor == null || key == null || !KEY.matcher(key).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Idempotency-Key");
        }
        String keyDigest = sha256(OP + "\n" + key);
        String requestDigest = fingerprint(request);

        jdbc.update("""
            DELETE FROM action_item_creation_idempotency
             WHERE actor_user_id=? AND key_digest=? AND expires_at <= clock_timestamp()
            """, actor, keyDigest);
        int inserted = jdbc.update("""
            INSERT INTO action_item_creation_idempotency
                (actor_user_id,key_digest,request_digest,expires_at)
            VALUES (?,?,?,clock_timestamp()+INTERVAL '24 hours')
            ON CONFLICT (actor_user_id,key_digest) DO NOTHING
            """, actor, keyDigest, requestDigest);
        if (inserted == 1) return null;
        List<Claim> existing = jdbc.query("""
            SELECT request_digest,action_item_id FROM action_item_creation_idempotency
             WHERE actor_user_id=? AND key_digest=?
            """, (rs, i) -> new Claim(rs.getString(1).trim(), rs.getObject(2,UUID.class)),
            actor, keyDigest);
        if (existing.size()!=1) throw new IllegalStateException("Idempotency claim missing");
        Claim prior = existing.getFirst();
        if (!prior.digest().equals(requestDigest)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Idempotency-Key belongs to another Action Item intent");
        }
        if (prior.itemId()==null) throw new IllegalStateException("Unfinished Action Item claim visible");
        return prior.itemId();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void complete(UUID actor, String key, UUID itemId) {
        if (jdbc.update("""
            UPDATE action_item_creation_idempotency SET action_item_id=?
             WHERE actor_user_id=? AND key_digest=? AND action_item_id IS NULL
            """, itemId,actor,sha256(OP+"\n"+key))!=1) {
            throw new IllegalStateException("Cannot complete Action Item idempotency claim");
        }
    }

    private String fingerprint(CreateActionItemRequest request) {
        List<Object> fields = Arrays.asList(
            request.meetingId().toString(), request.title().trim(),
            request.details()==null || request.details().isBlank() ? null : request.details().trim(),
            request.assigneeUserId().toString(),
            request.dueDate()==null ? null : request.dueDate().toString());
        return sha256(json.writeValueAsString(fields));
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private record Claim(String digest, UUID itemId) {}
}
