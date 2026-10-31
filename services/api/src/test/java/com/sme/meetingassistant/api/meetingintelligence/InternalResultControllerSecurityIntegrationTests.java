package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultAcceptance;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import jakarta.servlet.http.Cookie;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Real Spring Security chains and MVC HTTP semantics; only canonical ingestion
 * is mocked. Ingestion's PostgreSQL/lease/digest tests remain in MI-07 suite.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.mi.internal-result.enabled=true",
    "app.mi.internal-result.token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "app.mi.internal-result.previous-token=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    "app.media.outbox.enabled=false"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class InternalResultControllerSecurityIntegrationTests {
    private static final String URL="/internal/api/v1/meeting-intelligence/results/accept";
    private static final String TOKEN="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private static final String PREVIOUS="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

    @Autowired MockMvc mvc;
    @MockitoBean IntelligenceResultIngestion ingestion;
    private UUID stage, claim;
    private String digest;

    @BeforeEach
    void init() {
        stage=UUID.randomUUID();
        claim=UUID.randomUUID();
        digest="a".repeat(64);
        when(ingestion.ingest(any(StageClaim.class),anyString()))
            .thenReturn(new IntelligenceResultAcceptance.Acceptance(false,2));
    }

    private String body() {
        return "{\"stageRunId\":\""+stage+"\",\"claimToken\":\""+claim+
            "\",\"artifactSha256\":\""+digest+"\"}";
    }

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request(String token) {
        var req=post(URL).contentType(MediaType.APPLICATION_JSON).content(body());
        return token==null?req:req.header(HttpHeaders.AUTHORIZATION,"Bearer "+token);
    }

    @Test
    void missingWrongBrowserAndRegularJwtCredentialsCannotSubmit() throws Exception {
        mvc.perform(request(null)).andExpect(status().isUnauthorized());
        mvc.perform(request("wrong")).andExpect(status().isUnauthorized());
        mvc.perform(request("eyJhbGciOiJSUzI1NiJ9.fake.signature"))
            .andExpect(status().isUnauthorized());
        mvc.perform(request(TOKEN).cookie(new Cookie("sma_at","browser")))
            .andExpect(status().isUnauthorized());
        mvc.perform(request(TOKEN).header(HttpHeaders.AUTHORIZATION,"Bearer "+PREVIOUS))
            .andExpect(status().isUnauthorized());
        verifyNoInteractions(ingestion);
    }

    @Test
    void acceptedInternalIdentityUsesOnlyStageClaimAndDigestNotCallerBusinessMetadata()
            throws Exception {
        mvc.perform(request(TOKEN))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.success").value(true))
            .andExpect(jsonPath("$.data.replay").value(false))
            .andExpect(jsonPath("$.data.writtenRows").value(2))
            .andExpect(jsonPath("$.data.jobId").doesNotExist())
            .andExpect(jsonPath("$.data.meetingId").doesNotExist());
        ArgumentCaptor<StageClaim> captured=ArgumentCaptor.forClass(StageClaim.class);
        verify(ingestion).ingest(captured.capture(),org.mockito.ArgumentMatchers.eq(digest));
        assertThat(captured.getValue().stageRunId()).isEqualTo(stage);
        assertThat(captured.getValue().claimToken()).isEqualTo(claim);
    }

    @Test
    void previousCredentialAllowsControlledRotationAndReplay() throws Exception {
        when(ingestion.ingest(any(StageClaim.class),anyString()))
            .thenReturn(new IntelligenceResultAcceptance.Acceptance(true,0));
        mvc.perform(request(PREVIOUS))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.replay").value(true))
            .andExpect(jsonPath("$.data.writtenRows").value(0));
    }

    @Test
    void requestCannotInjectBusinessAuthorityOrArbitraryDigest() throws Exception {
        String tampered=body().replace("}",",\"meetingId\":\""+UUID.randomUUID()+"\"}");
        // The transport accepts only stage identity + digest, not business attribution.
        // Jackson's default handling for records is tested separately at this API boundary.
        mvc.perform(post(URL).header(HttpHeaders.AUTHORIZATION,"Bearer "+TOKEN)
                .contentType(MediaType.APPLICATION_JSON).content(tampered))
            .andExpect(status().is4xxClientError());
        mvc.perform(post(URL).header(HttpHeaders.AUTHORIZATION,"Bearer "+TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .content(body().replace(digest,"garbage")))
            .andExpect(status().isUnprocessableEntity());
        verifyNoInteractions(ingestion);
    }

    @Test
    void oldClaimIsConflictAndInvalidArtifactIsNonRetryable() throws Exception {
        when(ingestion.ingest(any(StageClaim.class),anyString()))
            .thenThrow(new ProcessingLifecycleConflictException("expired claim"));
        mvc.perform(request(TOKEN))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.message").value("The request conflicts with the current state."));
        verify(ingestion).ingest(any(StageClaim.class),anyString());
        reset(ingestion);
        when(ingestion.ingest(any(StageClaim.class),anyString()))
            .thenThrow(new IllegalArgumentException("private source or artifact"));
        mvc.perform(request(TOKEN))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.message").value("Request validation failed."));
    }

    @Test
    void transientPersistenceUnavailableIsSafe503AndCannotExposeErrorDetails()
            throws Exception {
        when(ingestion.ingest(any(StageClaim.class),anyString()))
            .thenThrow(new IllegalStateException("secret-private-key/path/result.json"));
        var response=mvc.perform(request(TOKEN)).andExpect(status().isServiceUnavailable())
            .andReturn().getResponse();
        assertThat(response.getContentAsString()).doesNotContain("secret-private-key");
    }

    @Test
    void protectedRouteNeverAcceptsGetOrCookieSessionAsAuthorization() throws Exception {
        mvc.perform(get(URL).header(HttpHeaders.AUTHORIZATION,"Bearer "+TOKEN))
            .andExpect(status().isMethodNotAllowed());
        mvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(body())
                .cookie(new Cookie("sma_at","valid-user-session")))
            .andExpect(status().isUnauthorized());
    }
}
