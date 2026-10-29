package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.userorganization.service.ServletAuthenticatedUserId;
import java.security.Principal;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

class ServletAuthenticatedUserIdTests {
    private final ServletAuthenticatedUserId identity = new ServletAuthenticatedUserId();

    @AfterEach
    void clearRequestContext() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void failClosedOutsideOfAnHttpRequest() {
        RequestContextHolder.resetRequestAttributes();
        assertUnauthorized(identity::requireUserId);
    }

    @Test
    void spoofedUserHeadersDoNotBecomeAuthenticatedPrincipals() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-User-Id", UUID.randomUUID().toString());
        request.addHeader("X-Role", "ADMINISTRATOR");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        assertUnauthorized(identity::requireUserId);
    }

    @Test
    void rejectsMalformedServerPrincipal() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setUserPrincipal(() -> "not-a-uuid");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        assertUnauthorized(identity::requireUserId);
    }

    @Test
    void resolvesOnlyTheServerProvidedPrincipalDuringRequest() {
        UUID userId = UUID.randomUUID();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setUserPrincipal((Principal) userId::toString);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        assertThat(identity.requireUserId()).isEqualTo(userId);
    }

    private static void assertUnauthorized(org.junit.jupiter.api.function.Executable action) {
        assertThatThrownBy(action::execute)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(exception -> assertThat(((ResponseStatusException) exception).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED));
    }
}
