package com.sme.meetingassistant.api.userorganization.bootstrap;

import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * One-time local/deployment operator path for creating an initial administrator
 * invitation.  It is intentionally not a controller or an ordinary startup
 * task.
 */
@Service
public class InitialAdministratorBootstrapService {
    private final JdbcTemplate jdbc;
    private final UserRepository users;
    private final AccountSetupService setup;

    public InitialAdministratorBootstrapService(JdbcTemplate jdbc, UserRepository users,
            AccountSetupService setup) {
        this.jdbc = jdbc;
        this.users = users;
        this.setup = setup;
    }

    @Transactional
    public BootstrapResult request(String email, String displayName) {
        InitialAdministratorBootstrapProperties.validateIdentity(email, displayName);
        String normalizedEmail = EmailNormalizer.normalize(email);

        Marker marker = jdbc.query("""
            SELECT state, user_id
              FROM initial_administrator_bootstrap
             WHERE id=1
             FOR UPDATE
            """, (rs, row) -> new Marker(
                rs.getString("state"),
                rs.getObject("user_id", UUID.class))).stream().findFirst()
            .orElseThrow(() -> new IllegalStateException(
                "Initial administrator bootstrap marker is missing"));

        if (activeAdministratorCount() > 0) {
            audit("INITIAL_ADMIN_BOOTSTRAP_ACTIVE_ADMIN_EXISTS", null,
                "{\"result\":\"blocked-active-administrator\"}");
            return new BootstrapResult(Status.ACTIVE_ADMIN_EXISTS, marker.userId());
        }

        if ("COMPLETED".equals(marker.state())) {
            audit("INITIAL_ADMIN_BOOTSTRAP_ALREADY_COMPLETED", marker.userId(),
                "{\"result\":\"already-completed\"}");
            return new BootstrapResult(Status.ALREADY_COMPLETED, marker.userId());
        }

        if ("ISSUED".equals(marker.state())) {
            audit("INITIAL_ADMIN_BOOTSTRAP_ALREADY_PENDING", marker.userId(),
                "{\"result\":\"already-pending-setup\"}");
            return new BootstrapResult(Status.ALREADY_PENDING, marker.userId());
        }

        List<PendingAdministrator> pendingAdministrators = jdbc.query("""
            SELECT id
              FROM users
             WHERE global_role='ADMINISTRATOR'
               AND account_status='PENDING_SETUP'
             ORDER BY created_at, id
             FOR UPDATE
            """, (rs, row) -> new PendingAdministrator(
                rs.getObject("id", UUID.class)));
        if (!pendingAdministrators.isEmpty()) {
            audit("INITIAL_ADMIN_BOOTSTRAP_PENDING_ADMIN_EXISTS", null,
                "{\"result\":\"blocked-existing-pending-administrator\"}");
            return new BootstrapResult(Status.PENDING_ADMIN_EXISTS, null);
        }

        if (users.existsByEmailNormalized(normalizedEmail)) {
            throw new IllegalStateException(
                "A user with the requested initial administrator email already exists");
        }

        UserEntity created;
        try {
            created = users.saveAndFlush(new UserEntity(
                email, displayName, GlobalRole.ADMINISTRATOR, null));
        } catch (DataIntegrityViolationException conflict) {
            throw new IllegalStateException(
                "Initial administrator could not be created because the identity already exists",
                conflict);
        }

        // The existing setup service stores only the verifier hash and queues
        // an email delivery.  No password or raw setup token is generated here.
        setup.enqueueInitialSetup(created);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        jdbc.update("""
            UPDATE initial_administrator_bootstrap
               SET state='ISSUED', user_id=?, email_normalized=?, requested_at=?
             WHERE id=1 AND state='AVAILABLE'
            """, created.getId(), normalizedEmail, now);
        audit("INITIAL_ADMIN_BOOTSTRAP_ISSUED", created.getId(),
            "{\"result\":\"pending-setup\",\"role\":\"ADMINISTRATOR\"}");
        return new BootstrapResult(Status.ISSUED, created.getId());
    }

    private int activeAdministratorCount() {
        Integer count = jdbc.queryForObject("""
            SELECT COUNT(*) FROM users
             WHERE global_role='ADMINISTRATOR' AND account_status='ACTIVE'
            """, Integer.class);
        return count == null ? 0 : count;
    }

    private void audit(String action, UUID entityId, String metadata) {
        jdbc.update("""
            INSERT INTO audit_events(
                id, occurred_at, actor_user_id, actor_type, action_code,
                entity_type, entity_id, metadata)
            VALUES (?, clock_timestamp(), NULL, 'SYSTEM', ?, 'USER', ?, CAST(? AS jsonb))
            """, UUID.randomUUID(), action, entityId, metadata);
    }

    public enum Status {
        ISSUED,
        ALREADY_PENDING,
        ALREADY_COMPLETED,
        ACTIVE_ADMIN_EXISTS,
        PENDING_ADMIN_EXISTS
    }

    public record BootstrapResult(Status status, UUID userId) {}

    private record Marker(String state, UUID userId) {}

    private record PendingAdministrator(UUID userId) {}
}
