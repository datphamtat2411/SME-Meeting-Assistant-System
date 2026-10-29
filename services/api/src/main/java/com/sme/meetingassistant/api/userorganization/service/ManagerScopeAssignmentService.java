package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.ManagerScopeUnitEntity;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import com.sme.meetingassistant.api.userorganization.repository.ManagerScopeUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationalUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Domain operation for T03's approved user-management API.
 * No public scope-grant endpoint is introduced in T02.
 * Only an ACTIVE administrator may grant/revoke a manager's explicit units.
 */
@Service
public class ManagerScopeAssignmentService {
    private final OrganizationalAuthorizationService authorization;
    private final UserRepository users;
    private final OrganizationalUnitRepository units;
    private final ManagerScopeUnitRepository scopes;

    public ManagerScopeAssignmentService(OrganizationalAuthorizationService authorization,
            UserRepository users, OrganizationalUnitRepository units,
            ManagerScopeUnitRepository scopes) {
        this.authorization = authorization;
        this.users = users;
        this.units = units;
        this.scopes = scopes;
    }

    @Transactional
    public void replaceManagerScopes(UUID targetManagerId, Set<UUID> approvedUnitIds) {
        UUID grantorId = authorization.requireAdministrator().getId();
        if (targetManagerId == null || approvedUnitIds == null || approvedUnitIds.stream().anyMatch(Objects::isNull)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        }
        var manager = users.findById(targetManagerId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (manager.getGlobalRole() != GlobalRole.DEPARTMENT_MANAGER) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        // Validate the entire replacement before any mutation to keep grants atomic.
        for (UUID id : approvedUnitIds) {
            if (!units.existsByIdAndStatus(id, OrganizationalUnitStatus.ACTIVE)) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
        }
        scopes.deleteAll(scopes.findByIdUserId(targetManagerId));
        scopes.flush();
        scopes.saveAll(approvedUnitIds.stream()
            .map(id -> new ManagerScopeUnitEntity(targetManagerId, id, grantorId))
            .toList());
        scopes.flush();
    }
}
