package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Verifies canonical T04 Argon2id credentials outside the session-admission transaction.
 * Transactional admission locks and re-reads the current user state, preventing both
 * stale-password logins and concurrent admission past the five-session limit.
 *
 * Internal server-only capability; HTTP transport and public endpoint are P4-T03/T05/T07.
 */
@Service
public class LoginAdmissionService {
    private final UserRepository users;
    private final AccountSetupPasswordHasher passwords;
    private final SessionAdmissionTransaction admission;
    private final String dummyVerifier;

    public LoginAdmissionService(UserRepository users, AccountSetupPasswordHasher passwords,
            SessionAdmissionTransaction admission) {
        this.users = users;
        this.passwords = passwords;
        this.admission = admission;
        this.dummyVerifier = passwords.hash("irrelevant-dummy-credential-with-sufficient-length");
    }

    /** Client type must come from a trusted server transport adapter, never self-granted role data. */
    public AdmittedLogin authenticateAndAdmit(String email, String password, AuthClientType clientType) {
        Objects.requireNonNull(clientType, "trusted clientType");
        if (email == null || email.isBlank() || email.length() > 320 ||
                password == null || password.isEmpty() || password.length() > 1024) {
            throw invalidCredentials();
        }
        String normalized = EmailNormalizer.normalize(email);
        var candidate = users.findByEmailNormalized(normalized);
        String verifier = candidate.filter(u -> u.getAccountStatus() == AccountStatus.ACTIVE)
            .map(u -> u.getPasswordHash())
            .filter(hash -> hash != null && hash.startsWith("$argon2id$"))
            .orElse(dummyVerifier);

        boolean valid;
        try {
            valid = passwords.matches(password, verifier);
        } catch (RuntimeException malformedHash) {
            valid = false;
        }
        if (!valid || candidate.isEmpty() || candidate.get().getAccountStatus() != AccountStatus.ACTIVE
                || !verifier.equals(candidate.get().getPasswordHash())) {
            throw invalidCredentials();
        }
        return admission.admit(candidate.get().getId(), verifier, clientType);
    }

    static ResponseStatusException invalidCredentials() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
    }

    /** Internal-only return value; do not serialize refresh credentials into Web JSON. */
    public record AdmittedLogin(UUID userId, UUID sessionId, AuthClientType clientType,
                                String refreshToken, OffsetDateTime refreshExpiresAt,
                                OffsetDateTime absoluteSessionExpiresAt) {}
}
