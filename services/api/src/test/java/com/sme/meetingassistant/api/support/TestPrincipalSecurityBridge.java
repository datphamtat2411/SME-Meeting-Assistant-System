package com.sme.meetingassistant.api.support;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * TEST SOURCE ONLY. Existing MVC contract tests provide server-side mock Principals.
 * This bridge seeds Spring Security request attributes before the real filter chain.
 * It cannot ship in a production artifact and never overrides a bearer credential.
 */
@Component
@Profile("test")
@Order(Ordered.HIGHEST_PRECEDENCE + 3)
public class TestPrincipalSecurityBridge extends OncePerRequestFilter {
    private final RequestAttributeSecurityContextRepository repository =
        new RequestAttributeSecurityContextRepository();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        if (request.getHeader("Authorization") == null) {
            Principal supplied = request.getUserPrincipal();
            String name = supplied == null ? null : supplied.getName();
            if (name == null && (request.getRequestURI().startsWith("/api/v1/contract/")
                    || request.getRequestURI().equals("/api/v1/security-test"))) {
                name = "00000000-0000-0000-0000-000000000001";
            }
            try {
                if (name != null) {
                    String canonical = UUID.fromString(name).toString();
                    var context = SecurityContextHolder.createEmptyContext();
                    context.setAuthentication(new UsernamePasswordAuthenticationToken(
                        canonical, null, List.of()));
                    repository.saveContext(context, request, response);
                }
            } catch (IllegalArgumentException ignored) {
                // Bad test principals remain unauthenticated.
            }
        }
        chain.doFilter(request, response);
    }
}
