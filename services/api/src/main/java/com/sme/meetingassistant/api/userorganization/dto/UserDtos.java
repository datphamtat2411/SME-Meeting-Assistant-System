package com.sme.meetingassistant.api.userorganization.dto;

import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.Set;
import java.util.UUID;

/**
 * Explicit API DTOs: credentials, token fields, and other private columns are never serialized.
 * Account setup is a separate T04 workflow; creation here only provisions PENDING_SETUP.
 */
public final class UserDtos {
    private UserDtos() {}

    public record CreateUser(
        @NotBlank @Email @Size(max = 320) String email,
        @NotBlank @Size(max = 200) String displayName,
        GlobalRole globalRole,
        UUID primaryOrgUnitId,
        Set<UUID> managerScopeUnitIds) {}

    public record UpdateUser(
        @Size(min = 1, max = 200) String displayName,
        UUID primaryOrgUnitId,
        GlobalRole globalRole,
        Set<UUID> managerScopeUnitIds) {}

    public record UpdateMyProfile(
        @NotBlank @Size(max = 200) String displayName) {}

    public record UserView(UUID id, String email, String displayName,
        GlobalRole globalRole, AccountStatus accountStatus, UUID primaryOrgUnitId,
        Set<UUID> managerScopeUnitIds, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
        public static UserView of(UserEntity entity, Set<UUID> managerScopeUnitIds) {
            return new UserView(entity.getId(), entity.getEmail(), entity.getDisplayName(),
                entity.getGlobalRole(), entity.getAccountStatus(), entity.getPrimaryOrgUnitId(),
                Set.copyOf(managerScopeUnitIds), entity.getCreatedAt(), entity.getUpdatedAt());
        }
    }

    public record MyProfile(UUID id, String email, String displayName,
        GlobalRole globalRole, AccountStatus accountStatus, UUID primaryOrgUnitId) {
        public static MyProfile of(UserEntity user) {
            return new MyProfile(user.getId(), user.getEmail(), user.getDisplayName(),
                user.getGlobalRole(), user.getAccountStatus(), user.getPrimaryOrgUnitId());
        }
    }
}
