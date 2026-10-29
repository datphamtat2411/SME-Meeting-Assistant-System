package com.sme.meetingassistant.api.authentication.transport;

import com.sme.meetingassistant.api.common.ApiErrorCode;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/** Consistent safe API error envelope for failures outside MVC exception advice. */
@Component
public class AuthSecurityFailureHandler implements AccessDeniedHandler, AuthenticationEntryPoint {
    private final ObjectMapper json;
    private final ApiResponseFactory responses;

    public AuthSecurityFailureHandler(ObjectMapper json, ApiResponseFactory responses) {
        this.json = json;
        this.responses = responses;
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response,
            AccessDeniedException exception) throws IOException {
        forbidden(response);
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
            AuthenticationException exception) throws IOException {
        response.setHeader(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        respond(response, 401, ApiErrorCode.AUTH_REQUIRED, "Authentication is required.");
    }

    public void forbidden(HttpServletResponse response) throws IOException {
        respond(response, 403, ApiErrorCode.AUTHZ_FORBIDDEN,
            "Access to this resource is forbidden.");
    }

    private void respond(HttpServletResponse response, int status, ApiErrorCode code,
            String message) throws IOException {
        if (response.isCommitted()) return;
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.getWriter().write(json.writeValueAsString(responses.error(code, message)));
    }
}
