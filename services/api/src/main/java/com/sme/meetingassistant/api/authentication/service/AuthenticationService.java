package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.dto.AuthRequests;
import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.userorganization.entity.UserAccountEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserAccountRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AuthenticationService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final UserAccountRepository users;
    private final RefreshTokenRepository refreshTokens;
    private final AuthenticationManager authenticationManager;
    private final PasswordEncoder passwordEncoder;
    private final JwtTokenService jwtTokens;
    private final java.time.Duration refreshTtl;

    public AuthenticationService(UserAccountRepository users, RefreshTokenRepository refreshTokens,
            AuthenticationManager authenticationManager, PasswordEncoder passwordEncoder, JwtTokenService jwtTokens,
            @Value("${app.auth.refresh-ttl:P30D}") java.time.Duration refreshTtl) {
        this.users = users; this.refreshTokens = refreshTokens; this.authenticationManager = authenticationManager;
        this.passwordEncoder = passwordEncoder; this.jwtTokens = jwtTokens; this.refreshTtl = refreshTtl;
    }

    @Transactional
    public AuthRequests.Tokens register(AuthRequests.Register request) {
        String normalized = normalize(request.email());
        if (users.existsByNormalizedEmail(normalized)) throw new ResponseStatusException(HttpStatus.CONFLICT);
        ensureBcryptLength(request.password());
        final UserAccountEntity user;
        try { user = users.saveAndFlush(new UserAccountEntity(request.email().trim(), normalized,
                passwordEncoder.encode(request.password()), request.displayName().trim())); }
        catch (DataIntegrityViolationException duplicateEmail) { throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicateEmail); }
        return issue(user);
    }

    @Transactional
    public AuthRequests.Tokens login(AuthRequests.Login request) {
        try { authenticationManager.authenticate(new UsernamePasswordAuthenticationToken(normalize(request.email()), request.password())); }
        catch (AuthenticationException invalidCredentials) { throw new ResponseStatusException(HttpStatus.UNAUTHORIZED); }
        UserAccountEntity user = users.findByNormalizedEmail(normalize(request.email()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        return issue(user);
    }

    @Transactional
    public AuthRequests.Tokens refresh(String presentedToken) {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        RefreshTokenEntity old = refreshTokens.findByHashForUpdate(hash(presentedToken))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        if (!old.isUsableAt(now)) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        UserAccountEntity user = users.findById(old.getUserId())
                .filter(account -> account.getStatus().name().equals("ACTIVE"))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        String nextValue = newRefreshToken();
        RefreshTokenEntity replacement = refreshTokens.save(new RefreshTokenEntity(user.getId(), hash(nextValue), now.plus(refreshTtl)));
        old.revoke(replacement.getId());
        refreshTokens.save(old);
        return issue(user, nextValue);
    }

    @Transactional
    public void logout(String presentedToken) {
        refreshTokens.findByHashForUpdate(hash(presentedToken)).ifPresent(token -> {
            if (token.isUsableAt(OffsetDateTime.now(ZoneOffset.UTC))) token.revoke(null);
            refreshTokens.save(token);
        });
    }

    private AuthRequests.Tokens issue(UserAccountEntity user) { return issue(user, newRefreshToken()); }
    private AuthRequests.Tokens issue(UserAccountEntity user, String rawRefresh) {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        refreshTokens.saveAndFlush(new RefreshTokenEntity(user.getId(), hash(rawRefresh), now.plus(refreshTtl)));
        JwtTokenService.IssuedAccessToken access = jwtTokens.issue(user.getId(), user.getEmail());
        return new AuthRequests.Tokens(access.value(), "Bearer", access.expiresInSeconds(), rawRefresh,
                user.getId().toString(), user.getEmail());
    }
    private static String normalize(String email) { return email.trim().toLowerCase(java.util.Locale.ROOT); }
    private static String newRefreshToken() { byte[] bytes = new byte[48]; RANDOM.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static String hash(String token) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    private static void ensureBcryptLength(String password) {
        if (password.getBytes(StandardCharsets.UTF_8).length > 72) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
