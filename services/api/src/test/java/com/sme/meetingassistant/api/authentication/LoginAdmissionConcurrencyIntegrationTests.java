package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

/**
 * No enclosing test transaction: multiple threads use independent committed DB transactions.
 * This catches the common 5-session admission race hidden by single-threaded MockMvc tests.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class LoginAdmissionConcurrencyIntegrationTests {
    @Autowired private UserRepository users;
    @Autowired private AuthSessionRepository sessions;
    @Autowired private RefreshTokenRepository tokens;
    @Autowired private LoginAdmissionService login;
    @Autowired private AccountSetupPasswordHasher passwordHasher;

    @Test
    void sixSimultaneousLoginsLeaveExactlyFiveLiveSessionFamilies() throws Exception {
        String password = "A long and unique Unicode passphrase 🦉 2026";
        UserEntity pending = users.saveAndFlush(new UserEntity(
            "concurrent-" + UUID.randomUUID() + "@example.com", "Parallel", GlobalRole.EMPLOYEE, null));
        pending.completeInitialSetup(passwordHasher.hash(password),
            OffsetDateTime.now(ZoneOffset.UTC));
        UserEntity user = users.saveAndFlush(pending);

        int attempts = 6;
        CountDownLatch ready = new CountDownLatch(attempts);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(attempts);
        try {
            var futures = new ArrayList<java.util.concurrent.Future<LoginAdmissionService.AdmittedLogin>>();
            for (int i = 0; i < attempts; i++) {
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    if (!start.await(20, TimeUnit.SECONDS))
                        throw new IllegalStateException("Concurrent login gate timed out");
                    return login.authenticateAndAdmit(user.getEmail(), password, AuthClientType.WEB);
                }));
            }
            assertThat(ready.await(20, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            List<UUID> ids = new ArrayList<>();
            for (var future : futures) {
                ids.add(future.get(90, TimeUnit.SECONDS).sessionId());
            }
            assertThat(ids).doesNotHaveDuplicates();
            assertThat(sessions.countByUserIdAndStatus(user.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(5);
            assertThat(sessions.countByUserIdAndStatus(user.getId(), AuthSessionStatus.REVOKED)).isEqualTo(1);
            assertThat(sessions.findByUserIdAndStatusOrderByCreatedAtAsc(user.getId(),
                AuthSessionStatus.REVOKED)).allSatisfy(
                session -> assertThat(session.getRevokeReason()).isEqualTo("SESSION_LIMIT"));
            assertThat(ids).hasSize(6);
            for (UUID id : ids) assertThat(tokens.findBySessionIdOrderByIssuedAtAsc(id)).hasSize(1);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(20, TimeUnit.SECONDS)).isTrue();
        }
    }
}
