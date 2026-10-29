package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Minimal cross-domain read boundary for eligible organizational identities.
 * Meeting code must not depend on UserRepository or internal account state mutations.
 */
@Service
@Transactional(readOnly = true)
public class OrganizationalIdentityLookup {
    private final UserRepository users;
    public OrganizationalIdentityLookup(UserRepository users) { this.users = users; }
    public boolean isActive(UUID id) {
        return id != null && users.findById(id)
            .filter(user -> user.getAccountStatus() == AccountStatus.ACTIVE).isPresent();
    }
    public Optional<Recipient> activeRecipient(UUID id) {
        if (id == null) return Optional.empty();
        return users.findById(id)
            .filter(user -> user.getAccountStatus() == AccountStatus.ACTIVE)
            .map(user -> new Recipient(user.getId(), user.getEmail()));
    }
    public Optional<Recipient> activeRecipientByEmail(String email) {
        if (email == null || email.isBlank()) return Optional.empty();
        return users.findByEmailNormalized(email.trim().toLowerCase(Locale.ROOT))
            .filter(user -> user.getAccountStatus() == AccountStatus.ACTIVE
                && user.getEmail().equalsIgnoreCase(email))
            .map(user -> new Recipient(user.getId(), user.getEmail()));
    }
    public record Recipient(UUID id, String email) { }
}
