package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * A compact identity/session projection; not a duplicate of /me/profile.
 * A JWT only identifies the user and session. Current role, directory-management
 * scope and account state are always sourced from canonical server-side records.
 *
 * Directory-management grants MUST NEVER be interpreted as meeting-content grants.
 */
@Service
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class AuthIdentityContextService {
    private final UserRepository users;
    private final AuthSessionRepository sessions;
    private final OrganizationalAuthorizationService directoryAuthorization;

    public AuthIdentityContextService(UserRepository users, AuthSessionRepository sessions,
            OrganizationalAuthorizationService directoryAuthorization) {
        this.users = users;
        this.sessions = sessions;
        this.directoryAuthorization = directoryAuthorization;
    }

    @Transactional(readOnly = true)
    public AuthContext current(Authentication authentication) {
        if (!(authentication instanceof JwtAuthenticationToken verified)) throw unauthorized();
        final UUID userId;
        final UUID sessionId;
        try {
            userId = UUID.fromString(verified.getToken().getSubject());
            sessionId = UUID.fromString(verified.getToken().getClaimAsString("sid"));
        } catch (RuntimeException missingIdentity) {
            throw unauthorized();
        }

        var user = users.findById(userId)
            .filter(current -> current.getAccountStatus() == AccountStatus.ACTIVE)
            .orElseThrow(AuthIdentityContextService::unauthorized);
        var session = sessions.findById(sessionId)
            .filter(current -> current.getUserId().equals(userId)
                && current.getStatus() == AuthSessionStatus.ACTIVE)
            .orElseThrow(AuthIdentityContextService::unauthorized);

        // LiveRs256JwtDecoder already performed the authoritative DB check before
        // this controller. Re-evaluate the session's persisted temporal boundaries
        // without touching last_seen_at in this read-only projection transaction.
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        OffsetDateTime lastActivity = session.getLastSeenAt() == null
            ? session.getCreatedAt() : session.getLastSeenAt();
        if (!now.isBefore(session.getAbsoluteExpiresAt())
                || !now.isBefore(lastActivity.plusDays(7))) throw unauthorized();

        boolean allDirectoryUnits = false;
        Set<UUID> grantedDirectoryUnits = Set.of();
        if (user.getGlobalRole() == GlobalRole.ADMINISTRATOR
                || user.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER) {
            var scope = directoryAuthorization.requireDirectoryManagementScope();
            allDirectoryUnits = scope.allUnits();
            // Same effective active grant set as User Directory and management
            // mutations. Historical grants remain persisted but never authorize.
            grantedDirectoryUnits = scope.unitIds();
        }
        return new AuthContext(user.getId(), user.getEmail(), user.getDisplayName(),
            user.getGlobalRole(), user.getAccountStatus(), user.getPrimaryOrgUnitId(),
            new DirectoryManagementScope(allDirectoryUnits, grantedDirectoryUnits),
            new SessionContext(session.getId(), session.getClientType(),
                session.getCreatedAt(), session.getLastSeenAt(),
                session.getAbsoluteExpiresAt()));
    }

    private static ResponseStatusException unauthorized() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication is required");
    }

    /** This is directory management only; meeting data requires separate authorization. */
    public record DirectoryManagementScope(boolean allUnits, Set<UUID> unitIds) {
        public DirectoryManagementScope {
            unitIds = Set.copyOf(unitIds);
        }
    }

    public record SessionContext(UUID id, AuthClientType clientType,
                                 OffsetDateTime createdAt, OffsetDateTime lastSeenAt,
                                 OffsetDateTime absoluteExpiresAt) { }

    public record AuthContext(UUID userId, String email, String displayName,
                              GlobalRole globalRole, AccountStatus accountStatus,
                              UUID primaryOrgUnitId,
                              DirectoryManagementScope directoryManagementScope,
                              SessionContext session) { }
}
