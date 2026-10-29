package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitEntity;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationalUnitRepository;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrganizationalUnitDirectoryService {
    private final OrganizationalAuthorizationService authorization;
    private final OrganizationalUnitRepository units;

    public OrganizationalUnitDirectoryService(OrganizationalAuthorizationService authorization,
            OrganizationalUnitRepository units) {
        this.authorization = authorization;
        this.units = units;
    }

    @Transactional(readOnly = true)
    public Page<OrganizationalUnitItem> listAuthorizedActiveUnits(int page, int size) {
        var scope = authorization.requireDirectoryManagementScope();
        var pageable = PageRequest.of(page, size,
            Sort.by(Sort.Order.asc("name"), Sort.Order.asc("id")));
        Page<OrganizationalUnitEntity> results;
        if (scope.allUnits()) {
            results = units.findByStatus(OrganizationalUnitStatus.ACTIVE, pageable);
        } else if (scope.unitIds().isEmpty()) {
            results = Page.empty(pageable);
        } else {
            results = units.findByIdInAndStatus(scope.unitIds(), OrganizationalUnitStatus.ACTIVE, pageable);
        }
        return results.map(OrganizationalUnitItem::from);
    }

    public record OrganizationalUnitItem(UUID id, String code, String name, UUID parentId,
                                         OrganizationalUnitStatus status) {
        static OrganizationalUnitItem from(OrganizationalUnitEntity unit) {
            return new OrganizationalUnitItem(unit.getId(), unit.getCode(), unit.getName(),
                unit.getParentId(), unit.getStatus());
        }
    }
}
