package com.sme.meetingassistant.api.userorganization.dto;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationRole;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.UUID;
public final class OrganizationDtos {
    private OrganizationDtos() { }
    public record Create(@NotBlank @Size(max=160) String name) { }
    public record Update(@NotBlank @Size(max=160) String name) { }
    public record AddMember(@NotBlank @jakarta.validation.constraints.Email String email,
            @NotNull OrganizationRole role) { }
    public record Organization(UUID id,String name,String slug,long version,OffsetDateTime createdAt) { }
    public record Member(UUID userId,String email,String displayName,OrganizationRole role,OffsetDateTime createdAt) { }
    public record UserProfile(UUID id,String email,String displayName,long version,OffsetDateTime createdAt) { }
    public record UpdateProfile(@NotBlank @Size(max=120) String displayName) { }
}
