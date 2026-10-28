package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.dto.UserDtos;
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

    public UserManagementService(OrganizationalAuthorizationService authorization,
            UserRepository users, OrganizationalUnitRepository units,
            ManagerScopeUnitRepository scopeRepository, ManagerScopeAssignmentService scopeAssignments) {
        this.authorization = authorization;
        this.users = users;
        this.units = units;
        this.scopeRepository = scopeRepository;
        this.scopeAssignments = scopeAssignments;
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
        return created;
    }

    @Transactional
    public UserEntity update(UUID userId, UserDtos.UpdateUser request, String ifMatch) {
        UserEntity target = getAuthorized(userId);
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
        if (request.globalRole() != null && nextRole != target.getGlobalRole()) {
            if (target.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER) {
                // Clear grants before demoting the manager, as T02 service requires manager role.
                scopeAssignments.replaceManagerScopes(target.getId(), Set.of());
            }
            target.assignGlobalRole(nextRole);
        }
        if (request.managerScopeUnitIds() != null) {
            // Must be a manager after the role change, never assign scopes to EMPLOYEE/ADMINISTRATOR.
            scopeAssignments.replaceManagerScopes(target.getId(), request.managerScopeUnitIds());
            target.markManagementScopeChanged();
        }
        try {
            return users.saveAndFlush(target);
        } catch (ObjectOptimisticLockingFailureException stale) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
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
