package com.sme.meetingassistant.api.userorganization.service;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationMembershipEntity;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationRole;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationStatus;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationMembershipRepository;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationRepository;
import java.util.EnumSet;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
@Component
public class OrganizationAccess {
    private final OrganizationMembershipRepository memberships;
    private final OrganizationRepository organizations;
    public OrganizationAccess(OrganizationMembershipRepository memberships,OrganizationRepository organizations){this.memberships=memberships;this.organizations=organizations;}
    public OrganizationMembershipEntity requireRole(UUID orgId,UUID userId,OrganizationRole... allowed){
        if(organizations.findByIdAndStatus(orgId, OrganizationStatus.ACTIVE).isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        OrganizationMembershipEntity member=memberships.findByOrganizationIdAndUserIdAndStatus(orgId,userId,"ACTIVE")
                .orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        var roles=EnumSet.noneOf(OrganizationRole.class); java.util.Collections.addAll(roles,allowed);
        if(!roles.contains(member.getRole())) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        return member;
    }
    public OrganizationMembershipEntity requireMember(UUID orgId,UUID userId){
        return requireRole(orgId,userId,OrganizationRole.OWNER,OrganizationRole.ADMIN,OrganizationRole.MEMBER);
    }
    public OrganizationMembershipEntity requireManager(UUID orgId,UUID userId){
        return requireRole(orgId,userId,OrganizationRole.OWNER,OrganizationRole.ADMIN);
    }
}
