package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.transport.AuthTransport;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import jakarta.servlet.http.Cookie;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.JsonNode;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = "app.auth.transport.enabled=true")
class AuthTransportHttpIntegrationTests {
    private static final String ORIGIN = "http://localhost:3000";
    private static final String PASS = "A long Unicode transport password 🔐 2026!";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserRepository users;
    @Autowired AuthSessionRepository sessions;
    @Autowired AccountSetupPasswordHasher hasher;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    private UserEntity user;

    @BeforeEach void userFixture() {
        UserEntity pending = new UserEntity("http-" + UUID.randomUUID() + "@example.com",
            "Browser Owner", GlobalRole.ADMINISTRATOR, null);
        pending.completeInitialSetup(hasher.hash(PASS), OffsetDateTime.now(ZoneOffset.UTC));
        user = users.saveAndFlush(pending);
    }

    private String json(Object payload) throws Exception { return mapper.writeValueAsString(payload); }
    private JsonNode data(MvcResult result) throws Exception {
        return mapper.readTree(result.getResponse().getContentAsString()).path("data");
    }
    private Cookie cookie(MvcResult result, String name) {
        List<String> headers = result.getResponse().getHeaders(HttpHeaders.SET_COOKIE);
        for (String header : headers) {
            if (header.startsWith(name + "=")) {
                return new Cookie(name, header.substring(name.length() + 1).split(";", 2)[0]);
            }
        }
        throw new AssertionError("Missing Set-Cookie for " + name);
    }
    private String setCookieHeader(MvcResult result, String name) {
        return result.getResponse().getHeaders(HttpHeaders.SET_COOKIE).stream()
            .filter(s -> s.startsWith(name + "=")).findFirst().orElseThrow();
    }
    private MvcResult bootstrap() throws Exception {
        return mvc.perform(get("/api/v1/auth/csrf").header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult webLogin() throws Exception {
        var bootstrap = bootstrap();
        var token = data(bootstrap).path("csrfToken").asText();
        return mvc.perform(post("/api/v1/auth/login")
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CSRF-Token", token)
            .cookie(cookie(bootstrap, AuthTransport.CSRF))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", user.getEmail(), "password", PASS))))
            .andExpect(status().isOk()).andReturn();
    }

    @Test
    void webLoginSetsHostOnlySecureHttpOnlyCookiesAndNoJsonBearerSecrets() throws Exception {
        var response = webLogin();
        String access = setCookieHeader(response, AuthTransport.ACCESS);
        String refresh = setCookieHeader(response, AuthTransport.REFRESH);
        String csrf = setCookieHeader(response, AuthTransport.CSRF);
        assertThat(access).contains("; Path=/", "Secure", "HttpOnly", "SameSite=Lax")
            .doesNotContain("Domain=");
        assertThat(refresh).contains("Path=/api/v1/auth", "Secure", "HttpOnly", "SameSite=Lax")
            .doesNotContain("Domain=");
        assertThat(csrf).contains("Path=/", "Secure", "SameSite=Lax")
            .doesNotContain("HttpOnly", "Domain=");
        assertThat(response.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        assertThat(response.getResponse().getContentAsString())
            .doesNotContain(cookie(response, AuthTransport.ACCESS).getValue(),
                cookie(response, AuthTransport.REFRESH).getValue(), "accessToken", "refreshToken");
        assertThat(data(response).path("sessionStatus").asText()).isEqualTo("ACTIVE");
        assertThat(data(response).path("csrfToken").asText())
            .isEqualTo(cookie(response, AuthTransport.CSRF).getValue());
    }

    @Test
    void browserCookieIsAValidRs256AuthenticationForProtectedGet() throws Exception {
        var login = webLogin();
        mvc.perform(get("/api/v1/me/profile").cookie(cookie(login, AuthTransport.ACCESS)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/organizational-units")
            .cookie(cookie(login, AuthTransport.ACCESS))).andExpect(status().isOk());
    }

    @Test
    void webMutationRequiresSignedSessionBoundCsrfAndExactOrigin() throws Exception {
        var login = webLogin();
        Cookie access = cookie(login, AuthTransport.ACCESS);
        Cookie csrf = cookie(login, AuthTransport.CSRF);
        String current = csrf.getValue();
        String update = json(Map.of("displayName", "New Browser Name"));
        mvc.perform(patch("/api/v1/me/profile").cookie(access, csrf)
            .header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content(update)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/me/profile").cookie(access, csrf)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CSRF-Token", "fake-token")
            .contentType(MediaType.APPLICATION_JSON).content(update))
            .andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/me/profile").cookie(access, csrf)
            .header(HttpHeaders.ORIGIN, "https://attacker.example")
            .header("X-CSRF-Token", current).contentType(MediaType.APPLICATION_JSON)
            .content(update)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/me/profile").cookie(access, csrf)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("Sec-Fetch-Site", "cross-site")
            .header("X-CSRF-Token", current).contentType(MediaType.APPLICATION_JSON)
            .content(update)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/me/profile").cookie(access, csrf)
            .header(HttpHeaders.ORIGIN, ORIGIN).header("X-CSRF-Token", current)
            .contentType(MediaType.APPLICATION_JSON).content(update))
            .andExpect(status().is(428)); // application If-Match follows valid CSRF
    }

    @Test
    void loginCsrfPreventsForcedBrowserSession() throws Exception {
        var start = bootstrap();
        String loginBody = json(Map.of("email", user.getEmail(), "password", PASS));
        var missingCsrf = mvc.perform(post("/api/v1/auth/login")
            .header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(loginBody))
            .andExpect(status().isForbidden()).andReturn();
        assertThat(mapper.readTree(missingCsrf.getResponse().getContentAsString())
            .path("code").asText()).isEqualTo("AUTHZ_FORBIDDEN");
        assertThat(missingCsrf.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
            .contains("no-store");
        mvc.perform(post("/api/v1/auth/login").header(HttpHeaders.ORIGIN, ORIGIN)
            .cookie(cookie(start, AuthTransport.CSRF))
            .contentType(MediaType.APPLICATION_JSON).content(loginBody))
            .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/auth/login").header(HttpHeaders.ORIGIN, "https://evil.invalid")
            .cookie(cookie(start, AuthTransport.CSRF))
            .header("X-CSRF-Token", data(start).path("csrfToken").asText())
            .contentType(MediaType.APPLICATION_JSON).content(loginBody))
            .andExpect(status().isForbidden());
        assertThat(sessions.countByUserIdAndStatus(user.getId(), AuthSessionStatus.ACTIVE)).isZero();
    }

    @Test
    void sessionCsrfFromAnotherBrowserSessionCannotAuthorizeMutation() throws Exception {
        var first = webLogin();
        var second = webLogin();
        mvc.perform(patch("/api/v1/me/profile")
            .cookie(cookie(second, AuthTransport.ACCESS), cookie(first, AuthTransport.CSRF))
            .header(HttpHeaders.ORIGIN, ORIGIN)
            .header("X-CSRF-Token", cookie(first, AuthTransport.CSRF).getValue())
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("displayName", "Cross-session attack"))))
            .andExpect(status().isForbidden());
    }

    @Test
    void webRefreshWorksWithExpiredAccessCookieAndCapsNewCookieAtSessionExpiry() throws Exception {
        var original = webLogin();
        var session = sessions.findByUserIdAndStatusOrderByCreatedAtAsc(
            user.getId(), AuthSessionStatus.ACTIVE).getFirst();
        jdbc.update("UPDATE auth_sessions SET absolute_expires_at=clock_timestamp() + INTERVAL '5 minutes' WHERE id=?",
            session.getId());
        // This test does not require an access JWT to perform refresh.
        var response = mvc.perform(post("/api/v1/auth/refresh")
            .header(HttpHeaders.ORIGIN, ORIGIN)
            .header("X-CSRF-Token", cookie(original, AuthTransport.CSRF).getValue())
            .cookie(cookie(original, AuthTransport.REFRESH), cookie(original, AuthTransport.CSRF)))
            .andExpect(status().isOk()).andReturn();
        String accessSetCookie = setCookieHeader(response, AuthTransport.ACCESS);
        var maxAge = java.util.regex.Pattern.compile("Max-Age=(\\d+)").matcher(accessSetCookie);
        assertThat(maxAge.find()).isTrue();
        assertThat(Long.parseLong(maxAge.group(1))).isLessThanOrEqualTo(300L);
        assertThat(data(response).path("sessionStatus").asText()).isEqualTo("ACTIVE");
    }

    @Test
    void webRefreshRotatesCookiesWithoutReturningCredentialsInJson() throws Exception {
        var original = webLogin();
        String oldRaw = cookie(original, AuthTransport.REFRESH).getValue();
        var result = mvc.perform(post("/api/v1/auth/refresh")
            .header(HttpHeaders.ORIGIN, ORIGIN)
            .header("X-CSRF-Token", cookie(original, AuthTransport.CSRF).getValue())
            .cookie(cookie(original, AuthTransport.REFRESH),
                cookie(original, AuthTransport.ACCESS), cookie(original, AuthTransport.CSRF)))
            .andExpect(status().isOk()).andReturn();
        assertThat(cookie(result, AuthTransport.REFRESH).getValue()).isNotEqualTo(oldRaw);
        assertThat(data(result).path("sessionStatus").asText()).isEqualTo("ACTIVE");
        assertThat(result.getResponse().getContentAsString()).doesNotContain(
            cookie(result, AuthTransport.REFRESH).getValue(),
            cookie(result, AuthTransport.ACCESS).getValue(), "refreshToken", "accessToken");
        mvc.perform(get("/api/v1/me/profile").cookie(cookie(result, AuthTransport.ACCESS)))
            .andExpect(status().isOk());
    }

    @Test
    void webLogoutClearsCookiesAndInvalidatesExistingJwt() throws Exception {
        var original = webLogin();
        mvc.perform(post("/api/v1/auth/logout").header(HttpHeaders.ORIGIN, ORIGIN)
            .cookie(cookie(original, AuthTransport.REFRESH), cookie(original, AuthTransport.CSRF))
            .header("X-CSRF-Token", cookie(original, AuthTransport.CSRF).getValue()))
            .andExpect(status().isOk())
            .andExpect(result -> {
                assertThat(setCookieHeader(result, AuthTransport.ACCESS)).contains("Max-Age=0");
                assertThat(setCookieHeader(result, AuthTransport.REFRESH)).contains("Max-Age=0");
                assertThat(setCookieHeader(result, AuthTransport.CSRF)).contains("Max-Age=0");
            });
        mvc.perform(get("/api/v1/me/profile").cookie(cookie(original, AuthTransport.ACCESS)))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void unauthenticatedApiReturnsCanonicalErrorEnvelope() throws Exception {
        var denied = mvc.perform(get("/api/v1/me/profile"))
            .andExpect(status().isUnauthorized()).andReturn();
        assertThat(mapper.readTree(denied.getResponse().getContentAsString())
            .path("code").asText()).isEqualTo("AUTH_REQUIRED");
    }

    @Test
    void mobileLoginRefreshAndLogoutUseBearerWithoutWebCookies() throws Exception {
        var response = mvc.perform(post("/api/v1/auth/login")
            .header(AuthTransport.PLATFORM, "mobile")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", user.getEmail(), "password", PASS))))
            .andExpect(status().isOk()).andReturn();
        assertThat(response.getResponse().getHeaders(HttpHeaders.SET_COOKIE)).isEmpty();
        String access = data(response).path("accessToken").asText();
        String refresh = data(response).path("refreshToken").asText();
        assertThat(data(response).path("tokenType").asText()).isEqualTo("Bearer");
        mvc.perform(get("/api/v1/me/profile").header(HttpHeaders.AUTHORIZATION, "Bearer " + access))
            .andExpect(status().isOk());
        var rotated = mvc.perform(post("/api/v1/auth/refresh")
            .header(AuthTransport.PLATFORM, "mobile")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + refresh))
            .andExpect(status().isOk()).andReturn();
        assertThat(data(rotated).path("refreshToken").asText()).isNotEqualTo(refresh);
        assertThat(rotated.getResponse().getHeaders(HttpHeaders.SET_COOKIE)).isEmpty();
        mvc.perform(post("/api/v1/auth/logout")
            .header(AuthTransport.PLATFORM, "mobile")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + data(rotated).path("accessToken").asText()))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/me/profile").header(HttpHeaders.AUTHORIZATION, "Bearer " + access))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void mobileTransportRejectsBrowserOriginAndCookieConfusion() throws Exception {
        mvc.perform(post("/api/v1/auth/login")
            .header(AuthTransport.PLATFORM, "mobile").header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", user.getEmail(), "password", PASS))))
            .andExpect(status().isForbidden());
        var original = webLogin();
        mvc.perform(post("/api/v1/auth/refresh").header(AuthTransport.PLATFORM, "mobile")
            .cookie(cookie(original, AuthTransport.REFRESH))
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + cookie(original, AuthTransport.REFRESH).getValue()))
            .andExpect(status().isForbidden());
    }

    @Test
    void corsAllowsOnlyConfiguredOriginWithCredentials() throws Exception {
        mvc.perform(options("/api/v1/auth/login")
            .header(HttpHeaders.ORIGIN, ORIGIN)
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "Content-Type,X-CSRF-Token"))
            .andExpect(status().isOk())
            .andExpect(r -> assertThat(r.getResponse().getHeader(
                HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isEqualTo(ORIGIN));
        mvc.perform(options("/api/v1/auth/login")
            .header(HttpHeaders.ORIGIN, "https://attacker.invalid")
            .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST"))
            .andExpect(status().isForbidden());
    }
}
