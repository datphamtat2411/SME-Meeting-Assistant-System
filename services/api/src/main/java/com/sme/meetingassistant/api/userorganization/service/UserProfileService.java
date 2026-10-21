package com.sme.meetingassistant.api.userorganization.service;
import com.sme.meetingassistant.api.userorganization.dto.OrganizationDtos;
import com.sme.meetingassistant.api.userorganization.entity.UserAccountEntity;
import com.sme.meetingassistant.api.userorganization.entity.UserAccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserAccountRepository;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
@Service
@Transactional
public class UserProfileService {
    private final UserAccountRepository users;
    public UserProfileService(UserAccountRepository users){this.users=users;}
    @Transactional(readOnly=true) public OrganizationDtos.UserProfile get(UUID id){return response(activeUser(id));}
    public OrganizationDtos.UserProfile update(UUID id,OrganizationDtos.UpdateProfile request){UserAccountEntity user=activeUser(id);user.updateProfile(request.displayName().trim());return response(user);}
    private UserAccountEntity activeUser(UUID id){return users.findById(id).filter(u->u.getStatus()==UserAccountStatus.ACTIVE).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));}
    private static OrganizationDtos.UserProfile response(UserAccountEntity u){return new OrganizationDtos.UserProfile(u.getId(),u.getEmail(),u.getDisplayName(),u.getVersion(),u.getCreatedAt());}
}
