package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.dto.UserDtos;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.ManagerScopeUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationalUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import jakarta.persistence.criteria.Predicate;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Organizational account management only; no authentication token or meeting access grants. */
@Service
public class UserManagementService {
    private final OrganizationalAuthorizationService authorization;
    private final UserRepository users;
    private final OrganizationalUnitRepository units;
    private final ManagerScopeUnitRepository scopeRepository;
    private final ManagerScopeAssignmentService scopeAssignments;
    private final AccountSetupService setup;
    private final RefreshSessionService sessions;
    private final JdbcTemplate jdbc;

    public UserManagementService(OrganizationalAuthorizationService authorization,
            UserRepository users, OrganizationalUnitRepository units,
            ManagerScopeUnitRepository scopeRepository, ManagerScopeAssignmentService scopeAssignments,
            AccountSetupService setup, RefreshSessionService sessions, JdbcTemplate jdbc) {
        this.authorization = authorization;
        this.users = users;
        this.units = units;
        this.scopeRepository = scopeRepository;
        this.scopeAssignments = scopeAssignments;
        this.setup = setup;
        this.sessions = sessions;
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public Page<UserDtos.UserView> list(String q, GlobalRole role, AccountStatus status, UUID orgUnitId,
            int page, int size) {
        var management = authorization.requireDirectoryManagementScope();
        var actor = authorization.requireActiveActor();
        if (!management.allUnits() && management.unitIds().isEmpty()) {
            return Page.empty(PageRequest.of(page, size));
        }
        Specification<UserEntity> filters = (root, query, cb) -> {
            var conditions = new ArrayList<Predicate>();
            if (!management.allUnits()) {
                conditions.add(root.get("primaryOrgUnitId").in(management.unitIds()));
                // A manager can administer employees in granted units, not other managers/admins.
                conditions.add(cb.equal(root.get("globalRole"), GlobalRole.EMPLOYEE));
            }
            if (orgUnitId != null) conditions.add(cb.equal(root.get("primaryOrgUnitId"), orgUnitId));
            if (role != null) conditions.add(cb.equal(root.get("globalRole"), role));
            if (status != null) conditions.add(cb.equal(root.get("accountStatus"), status));
            if (q != null && !q.isBlank()) {
                String pattern = "%" + escapeLike(q.trim().toLowerCase(Locale.ROOT)) + "%";
                conditions.add(cb.or(
                    cb.like(cb.lower(root.get("displayName")), pattern, '\\'),
                    cb.like(cb.lower(root.get("emailNormalized")), pattern, '\\')));
            }
            return cb.and(conditions.toArray(Predicate[]::new));
        };
        var pageable = PageRequest.of(page, size, Sort.by(Sort.Order.asc("displayName"), Sort.Order.asc("id")));
        return users.findAll(filters, pageable).map(user -> view(user, actor.getGlobalRole() == GlobalRole.ADMINISTRATOR));
    }

    private static String escapeLike(String text) {
        return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    @Transactional(readOnly = true)
    public UserEntity getAuthorized(UUID userId) {
        var management = authorization.requireDirectoryManagementScope();
        var user = users.findById(userId).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!management.allUnits() &&
                (user.getGlobalRole() != GlobalRole.EMPLOYEE || !management.includes(user.getPrimaryOrgUnitId()))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return user;
    }

    @Transactional(readOnly = true)
    public UserDtos.UserView viewAuthorized(UUID userId) {
        var actor = authorization.requireActiveActor();
        return view(getAuthorized(userId), actor.getGlobalRole() == GlobalRole.ADMINISTRATOR);
    }

    /** Provisioning is intentionally pending. T04 adds invitation delivery and credential setup. */
    @Transactional
    public UserEntity create(UserDtos.CreateUser request) {
        var actor = authorization.requireActiveActor();
        var management = authorization.requireDirectoryManagementScope();
        boolean administrator = actor.getGlobalRole() == GlobalRole.ADMINISTRATOR;
        GlobalRole newRole = request.globalRole() == null ? GlobalRole.EMPLOYEE : request.globalRole();
        if (!administrator && (request.globalRole() != null || request.managerScopeUnitIds() != null)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        if (!administrator && newRole != GlobalRole.EMPLOYEE) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        if (!administrator && (request.primaryOrgUnitId() == null ||
                !management.includes(request.primaryOrgUnitId()))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        validateActiveUnit(request.primaryOrgUnitId());
        validateScopeSelection(newRole, request.managerScopeUnitIds(), administrator);
        String emailNormalized = EmailNormalizer.normalize(request.email());
        if (users.existsByEmailNormalized(emailNormalized)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
        UserEntity created;
        try {
            created = users.saveAndFlush(new UserEntity(request.email(), request.displayName(),
                newRole, request.primaryOrgUnitId()));
        } catch (DataIntegrityViolationException uniqueConflict) {
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
        if (newRole == GlobalRole.DEPARTMENT_MANAGER && request.managerScopeUnitIds() != null) {
            scopeAssignments.replaceManagerScopes(created.getId(), request.managerScopeUnitIds());
            created.markManagementScopeChanged();
            created = users.saveAndFlush(created);
        }
        setup.enqueueInitialSetup(created);
        return created;
    }

    @Transactional
    public UserEntity update(UUID userId, UserDtos.UpdateUser request, String ifMatch) {
        // The same user-row lock is acquired by login and refresh rotation.
        // Lock before fetching the target into the persistence context, so
        // concurrent lifecycle commands cannot act on stale account state.
        UserEntity target = lockAuthorizedTarget(userId);
        UserVersionTags.requireMatch(target, ifMatch);
        UserEntity actor = authorization.requireActiveActor();
        boolean administrator = actor.getGlobalRole() == GlobalRole.ADMINISTRATOR;
        if (!administrator && (request.globalRole() != null || request.managerScopeUnitIds() != null)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        if (request.displayName() == null && request.primaryOrgUnitId() == null &&
                request.globalRole() == null && request.managerScopeUnitIds() == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        boolean locationChanged = request.primaryOrgUnitId() != null &&
            !request.primaryOrgUnitId().equals(target.getPrimaryOrgUnitId());
        if (request.primaryOrgUnitId() != null) {
            authorization.requireManagementOfActiveUnit(request.primaryOrgUnitId());
            target.assignPrimaryOrgUnit(request.primaryOrgUnitId());
        }
        if (request.displayName() != null) {
            if (request.displayName().isBlank()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
            target.renameDisplayName(request.displayName());
        }
        GlobalRole nextRole = request.globalRole() == null ? target.getGlobalRole() : request.globalRole();
        validateScopeSelection(nextRole, request.managerScopeUnitIds(), administrator);
        boolean roleChanged = nextRole != target.getGlobalRole();
        if (roleChanged) {
            if (target.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER) {
                // Clear grants while still a manager; changing the role alone
                // does not grant access to any meeting content.
                scopeAssignments.replaceManagerScopes(target.getId(), Set.of());
            }
            target.assignGlobalRole(nextRole);
        }
        boolean grantChanged = false;
        if (request.managerScopeUnitIds() != null) {
            Set<UUID> before = scopeRepository.findByIdUserId(target.getId()).stream()
                .map(scope -> scope.getId().getOrgUnitId())
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
            grantChanged = !before.equals(request.managerScopeUnitIds());
            if (grantChanged) {
                scopeAssignments.replaceManagerScopes(target.getId(), request.managerScopeUnitIds());
                target.markManagementScopeChanged();
            }
        }
        try {
            UserEntity changed = users.saveAndFlush(target);
            // Must be in the SAME transaction as the canonical role/scope write.
            // The auth domain owns the session/refresh invalidation implementation.
            if (roleChanged || locationChanged || grantChanged) {
                sessions.revokeAllForUser(changed.getId(),
                    roleChanged ? "ROLE_CHANGED" : "SCOPE_CHANGED");
                recordLifecycleEvent(roleChanged ? "ROLE_CHANGED" : "SCOPE_CHANGED",
                    actor.getId(), changed.getId());
            }
            return changed;
        } catch (ObjectOptimisticLockingFailureException stale) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }

    /**
     * Explicit ADMINISTRATOR-only repair of expired/dead initial setup.
     * No new session, password, role, or access right is issued.
     */
    @Transactional
    public UserEntity reissueInitialSetup(UUID userId, String ifMatch) {
        UserEntity actor = authorization.requireAdministrator();
        UserEntity target = users.findByIdForSessionAdmission(userId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        UserVersionTags.requireMatch(target, ifMatch);
        setup.reissueInitialSetup(target);
        target.markInitialSetupReissued();
        UserEntity changed = users.saveAndFlush(target);
        recordLifecycleEvent("ACCOUNT_SETUP_REISSUED", actor.getId(), changed.getId());
        return changed;
    }

    /** POST /users/{id}/deactivate — permanent session-family invalidation, no data deletion. */
    @Transactional
    public UserEntity deactivate(UUID userId, String ifMatch) {
        UserEntity actor = authorization.requireActiveActor();
        if (actor.getId().equals(userId)) {
            // Prevent accidentally locking the current administrator out of the service.
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Self-deactivation is not allowed");
        }
        UserEntity target = lockAuthorizedTarget(userId);
        UserVersionTags.requireMatch(target, ifMatch);
        if (target.getAccountStatus() != AccountStatus.ACTIVE) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Account is not active");
        }
        target.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        UserEntity changed = users.saveAndFlush(target);
        sessions.revokeAllForUser(changed.getId(), "ACCOUNT_DEACTIVATED");
        recordLifecycleEvent("ACCOUNT_DEACTIVATED", actor.getId(), changed.getId());
        return changed;
    }

    /** POST /users/{id}/reactivate — does not resurrect a previous session or token. */
    @Transactional
    public UserEntity reactivate(UUID userId, String ifMatch) {
        UserEntity target = lockAuthorizedTarget(userId);
        UserVersionTags.requireMatch(target, ifMatch);
        if (target.getAccountStatus() != AccountStatus.INACTIVE) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Account is not inactive");
        }
        if (target.getPasswordHash() == null
                || !target.getPasswordHash().startsWith("$argon2id$")
                || target.getCredentialChangedAt() == null) {
            // Do not activate an account which has never completed secure setup.
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Account requires secure credential setup");
        }
        target.reactivate();
        UserEntity changed = users.saveAndFlush(target);
        // Revocation from the previous inactive transition is permanent.
        // Reactivation creates no session and does not re-issue refresh tokens.
        recordLifecycleEvent("ACCOUNT_REACTIVATED",
            authorization.requireActiveActor().getId(), changed.getId());
        return changed;
    }

    private UserEntity lockAuthorizedTarget(UUID userId) {
        var management = authorization.requireDirectoryManagementScope();
        UserEntity target = users.findByIdForSessionAdmission(userId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!management.allUnits() &&
            (target.getGlobalRole() != GlobalRole.EMPLOYEE
                || !management.includes(target.getPrimaryOrgUnitId()))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return target;
    }

    private void recordLifecycleEvent(String action, UUID actorId, UUID targetId) {
        // This audit row lives in the same transaction as the lifecycle change
        // and session invalidation. No raw credentials, email, IP or token details.
        jdbc.update("""
            INSERT INTO audit_events(id,occurred_at,actor_user_id,actor_type,
                action_code,entity_type,entity_id)
            VALUES (?,?,?,'USER',?,'USER',?)
            """, UUID.randomUUID(), OffsetDateTime.now(ZoneOffset.UTC),
            actorId, action, targetId);
    }

    @Transactional(readOnly = true)
    public UserDtos.UserView view(UserEntity user, boolean includeManagerScopes) {
        Set<UUID> scopeIds = includeManagerScopes && user.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER
            ? scopeRepository.findByIdUserId(user.getId()).stream()
                .map(scope -> scope.getId().getOrgUnitId())
                .collect(java.util.stream.Collectors.toUnmodifiableSet())
            : Set.of();
        return UserDtos.UserView.of(user, scopeIds);
    }

    private void validateActiveUnit(UUID id) {
        if (id != null && !units.existsByIdAndStatus(id, OrganizationalUnitStatus.ACTIVE)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }

    private static void validateScopeSelection(GlobalRole role, Set<UUID> scopes, boolean administrator) {
        if (scopes != null && !administrator) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        if (scopes != null && role != GlobalRole.DEPARTMENT_MANAGER) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        if (scopes != null && scopes.stream().anyMatch(java.util.Objects::isNull)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }

    @Transactional(readOnly = true)
    public UserEntity getMyProfile() {
        return authorization.requireActiveActor();
    }

    @Transactional
    public UserEntity updateMyProfile(UserDtos.UpdateMyProfile request, String ifMatch) {
        UserEntity actor = authorization.requireActiveActor();
        UserVersionTags.requireMatch(actor, ifMatch);
        try {
            actor.renameDisplayName(request.displayName());
            return users.saveAndFlush(actor);
        } catch (ObjectOptimisticLockingFailureException stale) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
