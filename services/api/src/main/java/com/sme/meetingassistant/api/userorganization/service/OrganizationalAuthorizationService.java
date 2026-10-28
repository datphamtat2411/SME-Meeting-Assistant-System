package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.ManagerScopeUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationalUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Account-management authorization only. Meeting content is a separate relationship-based
 * authorization domain; neither ADMINISTRATOR nor a scope row conveys meeting-data access.
 */
@Service
public class OrganizationalAuthorizationService {
    private final AuthenticatedUserId authenticatedUserId;
    private final UserRepository users;
    private final OrganizationalUnitRepository units;
    private final ManagerScopeUnitRepository scopeUnits;

    public OrganizationalAuthorizationService(AuthenticatedUserId authenticatedUserId,
            UserRepository users, OrganizationalUnitRepository units,
            ManagerScopeUnitRepository scopeUnits) {
        this.authenticatedUserId = authenticatedUserId;
        this.users = users;
        this.units = units;
        this.scopeUnits = scopeUnits;
    }

    @Transactional(readOnly = true)
    public UserEntity requireActiveActor() {
        return users.findById(authenticatedUserId.requireUserId())
            .filter(user -> user.getAccountStatus() == AccountStatus.ACTIVE)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
    }

    @Transactional(readOnly = true)
    public UserEntity requireAdministrator() {
        UserEntity actor = requireActiveActor();
        if (actor.getGlobalRole() != GlobalRole.ADMINISTRATOR) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        return actor;
    }

    /** Return only management powers; never use this as a meeting-content visibility scope. */
    @Transactional(readOnly = true)
    public ManagementScope requireDirectoryManagementScope() {
        UserEntity actor = requireActiveActor();
        if (actor.getGlobalRole() == GlobalRole.ADMINISTRATOR) {
            return ManagementScope.unrestricted();
        }
        if (actor.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER) {
            Set<UUID> ids = scopeUnits.findByIdUserId(actor.getId()).stream()
                .map(scope -> scope.getId().getOrgUnitId())
                .collect(Collectors.toUnmodifiableSet());
            return ManagementScope.restricted(ids);
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }

    /** For mutations against a specific active unit, a department manager needs an exact grant. */
    @Transactional(readOnly = true)
    public void requireManagementOfActiveUnit(UUID unitId) {
        UserEntity actor = requireActiveActor();
        if (unitId == null || !units.existsByIdAndStatus(unitId, OrganizationalUnitStatus.ACTIVE)) {
            // Do not disclose existence or inactivity to unauthorized actors.
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        if (actor.getGlobalRole() == GlobalRole.ADMINISTRATOR) {
            return;
        }
        if (actor.getGlobalRole() == GlobalRole.DEPARTMENT_MANAGER &&
                scopeUnits.existsByIdUserIdAndIdOrgUnitId(actor.getId(), unitId)) {
            return;
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }

    public record ManagementScope(boolean allUnits, Set<UUID> unitIds) {
        public ManagementScope {
            unitIds = Set.copyOf(unitIds);
        }
        public static ManagementScope unrestricted() {
            return new ManagementScope(true, Set.of());
        }
        public static ManagementScope restricted(Set<UUID> unitIds) {
            return new ManagementScope(false, unitIds);
        }
        public boolean includes(UUID unitId) {
            return allUnits || unitIds.contains(unitId);
        }
    }
}
