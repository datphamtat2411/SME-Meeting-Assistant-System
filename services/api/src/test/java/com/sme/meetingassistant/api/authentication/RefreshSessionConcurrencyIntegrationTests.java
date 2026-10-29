package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.server.ResponseStatusException;

/** True independent PostgreSQL transactions: exactly one rotation, then replay revokes family. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class RefreshSessionConcurrencyIntegrationTests {
    @Autowired UserRepository users;
    @Autowired AuthSessionRepository sessions;
    @Autowired RefreshTokenRepository tokens;
    @Autowired LoginAdmissionService login;
    @Autowired RefreshSessionService refresh;
    @Autowired AccountSetupPasswordHasher passwords;

    @Test
    void concurrentConsumptionOfAAllowsOneBAndCommitsCompromiseResponse() throws Exception {
        String password = "Long concurrent refresh passphrase 🗝️ 2026";
        UserEntity pending = new UserEntity("parallel-rt-" + UUID.randomUUID()
            + "@example.com", "Parallel", GlobalRole.EMPLOYEE, null);
        pending.completeInitialSetup(passwords.hash(password),
            OffsetDateTime.now(ZoneOffset.UTC));
        var user = users.saveAndFlush(pending);
        var admission = login.authenticateAndAdmit(user.getEmail(), password, AuthClientType.MOBILE);

        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var futures = new ArrayList<java.util.concurrent.Future<Object>>();
            for (int i = 0; i < 2; i++) {
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    if (!start.await(20, TimeUnit.SECONDS))
                        throw new IllegalStateException("Concurrent refresh gate timed out");
                    try {
                        return refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE);
                    } catch (ResponseStatusException invalid) {
                        return invalid;
                    }
                }));
            }
            assertThat(ready.await(20, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var responses = new ArrayList<Object>();
            for (var future : futures) responses.add(future.get(90, TimeUnit.SECONDS));

            assertThat(responses.stream().filter(r -> r instanceof RefreshSessionService.RotatedRefresh)
                .count()).isEqualTo(1);
            assertThat(responses.stream().filter(r -> r instanceof ResponseStatusException)
                .count()).isEqualTo(1);
            assertThat(responses.stream().filter(r -> r instanceof ResponseStatusException)
                .map(r -> (ResponseStatusException) r))
                .allSatisfy(r -> assertThat(r.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));

            var family = sessions.findById(admission.sessionId()).orElseThrow();
            assertThat(family.getStatus()).isEqualTo(AuthSessionStatus.REVOKED);
            assertThat(family.getRevokeReason()).isEqualTo("REFRESH_REUSE");
            var lineage = tokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId());
            assertThat(lineage).hasSize(2);
            assertThat(lineage.getFirst().getConsumedAt()).isNotNull();
            assertThat(lineage.getFirst().getReplacedByTokenId())
                .isEqualTo(lineage.get(1).getId());
            assertThat(lineage).allSatisfy(t -> assertThat(t.getRevokedAt()).isNotNull());
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(20, TimeUnit.SECONDS)).isTrue();
        }
    }
}
