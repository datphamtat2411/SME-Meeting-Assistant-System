package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.dto.OrganizationDtos;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import java.text.Normalizer;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class OrganizationService {
    private final OrganizationRepository organizations; private final OrganizationMembershipRepository memberships;
    private final UserAccountRepository users; private final OrganizationAccess access;
    public OrganizationService(OrganizationRepository organizations,OrganizationMembershipRepository memberships,
            UserAccountRepository users,OrganizationAccess access){this.organizations=organizations;this.memberships=memberships;this.users=users;this.access=access;}

    public OrganizationDtos.Organization create(UUID callerId,OrganizationDtos.Create request){
        users.findById(callerId).filter(u->u.getStatus()==UserAccountStatus.ACTIVE).orElseThrow(()->new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        String name=request.name().trim(); String base=slug(name); String unique=base+"-"+UUID.randomUUID().toString().substring(0,8);
        OrganizationEntity org=organizations.saveAndFlush(new OrganizationEntity(name,unique));
        memberships.save(new OrganizationMembershipEntity(org.getId(),callerId,OrganizationRole.OWNER));
        return response(org);
    }
    @Transactional(readOnly=true)
    public List<OrganizationDtos.Organization> list(UUID callerId){return memberships.findByUserIdAndStatusOrderByCreatedAtDesc(callerId,"ACTIVE").stream()
            .map(m->organizations.findByIdAndStatus(m.getOrganizationId(),OrganizationStatus.ACTIVE).orElse(null))
            .filter(java.util.Objects::nonNull).map(OrganizationService::response).toList();}
    @Transactional(readOnly=true)
    public OrganizationDtos.Organization get(UUID orgId,UUID callerId){access.requireMember(orgId,callerId);return organizations.findById(orgId).map(OrganizationService::response).orElseThrow();}
    public OrganizationDtos.Organization update(UUID orgId,UUID callerId,OrganizationDtos.Update request){
        access.requireManager(orgId,callerId); OrganizationEntity org=organizations.findById(orgId).orElseThrow();org.rename(request.name().trim());return response(org);
    }
    @Transactional(readOnly=true)
    public List<OrganizationDtos.Member> members(UUID orgId,UUID callerId){access.requireMember(orgId,callerId);
        return memberships.findByOrganizationIdAndStatusOrderByCreatedAtAsc(orgId,"ACTIVE").stream().map(this::memberResponse).toList();}
    public OrganizationDtos.Member addMember(UUID orgId,UUID callerId,OrganizationDtos.AddMember request){
        OrganizationMembershipEntity actor=access.requireManager(orgId,callerId);
        if(request.role()!=OrganizationRole.MEMBER&&actor.getRole()!=OrganizationRole.OWNER)throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        UserAccountEntity user=users.findByNormalizedEmail(request.email().trim().toLowerCase(java.util.Locale.ROOT))
                .filter(u->u.getStatus()==UserAccountStatus.ACTIVE).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        OrganizationMembershipEntity member=memberships.findByOrganizationIdAndUserId(orgId,user.getId()).orElse(null);
        if(member==null)member=memberships.saveAndFlush(new OrganizationMembershipEntity(orgId,user.getId(),request.role()));
        else if(member.getStatus().equals("ACTIVE"))throw new ResponseStatusException(HttpStatus.CONFLICT);
        else member.changeRole(request.role());
        return memberResponse(member);
    }
    public void removeMember(UUID orgId,UUID targetId,UUID callerId){
        OrganizationMembershipEntity actor=access.requireManager(orgId,callerId);
        OrganizationMembershipEntity target=memberships.findByOrganizationIdAndUserIdAndStatus(orgId,targetId,"ACTIVE")
                .orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        if(actor.getRole()==OrganizationRole.ADMIN&&target.getRole()!=OrganizationRole.MEMBER)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        if(target.getRole()==OrganizationRole.OWNER){
            if(actor.getRole()!=OrganizationRole.OWNER)throw new ResponseStatusException(HttpStatus.FORBIDDEN);
            if(memberships.countByOrganizationIdAndRoleAndStatus(orgId,OrganizationRole.OWNER,"ACTIVE")<=1)
                throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
        target.remove();
    }
    private OrganizationDtos.Member memberResponse(OrganizationMembershipEntity m){
        UserAccountEntity user=users.findById(m.getUserId()).orElseThrow();
        return new OrganizationDtos.Member(user.getId(),user.getEmail(),user.getDisplayName(),m.getRole(),m.getCreatedAt());
    }
    private static OrganizationDtos.Organization response(OrganizationEntity org){return new OrganizationDtos.Organization(org.getId(),org.getName(),org.getSlug(),org.getVersion(),org.getCreatedAt());}
    private static String slug(String input){String value=Normalizer.normalize(input,Normalizer.Form.NFD).replaceAll("\\p{M}+","").toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+","-").replaceAll("^-|-$","");return value.isBlank()?"organization":value.substring(0,Math.min(value.length(),160));}
}
