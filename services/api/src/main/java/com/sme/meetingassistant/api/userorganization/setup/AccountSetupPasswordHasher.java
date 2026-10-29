package com.sme.meetingassistant.api.userorganization.setup;

import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.stereotype.Component;

/** Argon2id; salt 16 bytes, hash 32 bytes, memory 19 MiB, iterations 2, parallelism 1. */
@Component
public class AccountSetupPasswordHasher {
    private final Argon2PasswordEncoder encoder = new Argon2PasswordEncoder(16, 32, 1, 19 * 1024, 2);

    public String hash(String password) { return encoder.encode(password); }
    public boolean matches(String password, String verifier) { return encoder.matches(password, verifier); }
}
