package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.*;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** PostgreSQL + full MVC; SMTP boundary is a Mockito-backed fake sender (no external network). */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@Transactional
class AccountSetupIntegrationTests {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private UserRepository users;
    @Autowired private AccountSetupTokenCodec codec;
    @Autowired private AccountSetupPasswordHasher hasher;
    @Autowired private AccountSetupDeliveryWorker worker;
    @MockitoBean private JavaMailSender smtp;

    private UserEntity admin;

    @BeforeEach
    void setUp() {
        admin = new UserEntity("admin-setup-" + UUID.randomUUID() + "@example.com",
            "Administrator", GlobalRole.ADMINISTRATOR, null);
        ReflectionTestUtils.setField(admin, "accountStatus", AccountStatus.ACTIVE);
        ReflectionTestUtils.setField(admin, "passwordHash", "fixture-auth-verifier");
        admin = users.saveAndFlush(admin);
    }

    private String serialize(Object value) {
        return json.writeValueAsString(value);
    }

    private UUID createPending() throws Exception {
        String email = "invited-" + UUID.randomUUID() + "@example.com";
        var result = mvc.perform(post("/api/v1/users").principal((Principal) () -> admin.getId().toString())
            .contentType(MediaType.APPLICATION_JSON)
            .content(serialize(Map.of("email", email, "displayName", "Invited User",
                "globalRole", "EMPLOYEE"))))
            .andExpect(status().isCreated()).andReturn();
        JsonNode data = json.readTree(result.getResponse().getContentAsString()).path("data");
        assertThat(data.path("accountStatus").asText()).isEqualTo("PENDING_SETUP");
        assertThat(result.getResponse().getContentAsString())
            .doesNotContain("passwordHash", "tokenHash", "setupToken", "password");
        return UUID.fromString(data.path("id").asText());
    }

    private UUID tokenId(UUID userId) {
        return jdbc.queryForObject("SELECT id FROM account_setup_tokens WHERE user_id=?",
            UUID.class, userId);
    }

    private String token(UUID userId) {
        return codec.issue(tokenId(userId));
    }

    private void submit(String token, String password, int statusCode) throws Exception {
        mvc.perform(post("/api/v1/auth/account-setup").contentType(MediaType.APPLICATION_JSON)
            .content(serialize(Map.of("token", token, "password", password))))
            .andExpect(status().is(statusCode));
    }

    @Test
    void accountCreationCommitsTokenVerifierAndEmailIntentWithoutSecrets() throws Exception {
        UUID userId = createPending();
        UUID id = tokenId(userId);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM account_setup_tokens WHERE id=?",
            String.class, id)).isEqualTo(codec.sha256(codec.issue(id)));
        assertThat(jdbc.queryForObject("""
            SELECT expires_at <= requested_at + INTERVAL '24 hours'
            FROM account_setup_tokens WHERE id=?
            """, Boolean.class, id)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
            """, String.class, id)).isEqualTo("PENDING");
        assertThat(users.findById(userId).orElseThrow().getPasswordHash()).isNull();
    }

    @Test
    void smtpWorkerDeliversDedicatedTokenWithoutPersistingItsPlaintext() throws Exception {
        UUID userId = createPending();
        assertThat(worker.deliverOne()).isTrue();
        ArgumentCaptor<SimpleMailMessage> captor = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp).send(captor.capture());
        SimpleMailMessage message = captor.getValue();
        assertThat(message.getTo()).containsExactly(users.findById(userId).orElseThrow().getEmail());
        assertThat(message.getText()).contains("#token=" + token(userId));
        assertThat(message.getText()).doesNotContain("passwordHash", "refreshToken", "Bearer ");
        assertThat(jdbc.queryForObject("SELECT status FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(userId))).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("SELECT token_hash FROM account_setup_tokens WHERE id=?",
            String.class, tokenId(userId))).doesNotContain(token(userId));
    }

    @Test
    void validTokenActivatesOnceWithArgon2idAndCredentialTimestamp() throws Exception {
        UUID userId = createPending();
        String bearer = token(userId);
        String password = "Mật khẩu rất dài có Unicode 🚀 và spaces 2026!";
        submit(bearer, password, 200);
        UserEntity activated = users.findById(userId).orElseThrow();
        assertThat(activated.getAccountStatus()).isEqualTo(AccountStatus.ACTIVE);
        assertThat(activated.getCredentialChangedAt()).isNotNull();
        assertThat(activated.getPasswordHash()).startsWith("$argon2id$");
        assertThat(hasher.matches(password, activated.getPasswordHash())).isTrue();
        assertThat(jdbc.queryForObject("SELECT used_at FROM account_setup_tokens WHERE id=?",
            OffsetDateTime.class, tokenId(userId))).isNotNull();
        submit(bearer, "Different strong password 2026!", 422);
        assertThat(users.findById(userId).orElseThrow().getPasswordHash())
            .isEqualTo(activated.getPasswordHash());
    }

    @Test
    void invalidExpiredAndRevokedTokensNeverChangePassword() throws Exception {
        UUID userId = createPending();
        String bearer = token(userId);
        submit("not-a-token", "A sufficiently strong Unicode password 2026", 422);
        submit(bearer + "x", "A sufficiently strong Unicode password 2026", 422);
        jdbc.update("UPDATE account_setup_tokens SET expires_at = requested_at + INTERVAL '1 second' WHERE id=?",
            tokenId(userId));
        submit(bearer, "A sufficiently strong Unicode password 2026", 422);
        jdbc.update("UPDATE account_setup_tokens SET revoked_at=now(),expires_at=requested_at + INTERVAL '24 hours' WHERE id=?",
            tokenId(userId));
        submit(bearer, "A sufficiently strong Unicode password 2026", 422);
        assertThat(users.findById(userId).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.PENDING_SETUP);
    }

    @Test
    void passwordPolicyAccepts128UnicodeCodePointsButRejectsWeakOrShort() throws Exception {
        UUID id = createPending();
        String bearer = token(id);
        submit(bearer, "short password", 422);
        submit(bearer, "passwordpassword", 422);
        submit(bearer, "MeetingAssistant2026", 422);
        String strong = "🚀".repeat(128);
        submit(bearer, strong, 200);
        assertThat(hasher.matches(strong, users.findById(id).orElseThrow().getPasswordHash())).isTrue();
    }

    @Test
    void smtpFailureDoesNotRollbackAccountAndRetryCanDeliver() throws Exception {
        UUID id = createPending();
        doThrow(new MailSendException("provider secret details must never be stored"))
            .doNothing().when(smtp).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(users.findById(id).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.PENDING_SETUP);
        assertThat(jdbc.queryForObject("SELECT status FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(id))).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT last_error_code FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(id))).isEqualTo("SMTP_DELIVERY_FAILED");
        assertThat(jdbc.queryForObject("SELECT last_error_summary FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(id))).isNull();
        jdbc.update("UPDATE email_deliveries SET next_attempt_at = now() - INTERVAL '1 minute' WHERE related_entity_id=?",
            tokenId(id));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(id))).isEqualTo("SENT");
    }

    @Test
    void consumedSetupTokenIsNotMailedByRetryWorker() throws Exception {
        UUID id = createPending();
        submit(token(id), "A strong password that was accepted 2026", 200);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM email_deliveries WHERE related_entity_id=?",
            String.class, tokenId(id))).isEqualTo("DEAD");
        org.mockito.Mockito.verifyNoInteractions(smtp);
    }
}
