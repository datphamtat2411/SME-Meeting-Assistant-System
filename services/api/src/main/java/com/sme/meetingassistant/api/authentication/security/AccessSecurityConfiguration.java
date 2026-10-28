package com.sme.meetingassistant.api.authentication.security;

import com.sme.meetingassistant.api.authentication.transport.*;
import com.sme.meetingassistant.api.config.HttpSecurityProperties;
import jakarta.servlet.http.Cookie;
import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.web.BearerTokenResolver;
import org.springframework.security.oauth2.server.resource.web.DefaultBearerTokenResolver;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;

/**
 * Cookie access JWT and Mobile bearer share one verified RS256 resource-server chain.
 * Spring CsrfFilter enforces browser cookie/header proof; an additional filter checks
 * HMAC session binding and trusted browser Origin on all cookie-authenticated writes.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class AccessSecurityConfiguration {
    @Bean
    JwtDecoder rs256JwtDecoder(RsaJwtKeys keys, SessionAuthority sessions) {
        return new LiveRs256JwtDecoder(keys, sessions);
    }

    @Bean
    SecurityFilterChain apiAccessSecurity(HttpSecurity http, JwtDecoder jwtDecoder,
            ObjectProvider<SessionCsrfTokens> csrfTokens, RefreshSessionLocator locator,
            ObjectProvider<WebLogoutIdentityResolver> logoutIdentity,
            HttpSecurityProperties properties, AuthSecurityFailureHandler failures,
            @Value("${app.auth.transport.enabled:false}") boolean transportEnabled) throws Exception {
        http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        http.exceptionHandling(ex -> ex.accessDeniedHandler(failures));
        // Existing trusted-proxy-aware filter is the sole HSTS authority.
        http.headers(headers -> headers.httpStrictTransportSecurity(hsts -> hsts.disable()));
        var csrfCookie = CookieCsrfTokenRepository.withHttpOnlyFalse();
        csrfCookie.setCookieName(AuthTransport.CSRF);
        csrfCookie.setCookiePath("/");
        csrfCookie.setHeaderName("X-CSRF-Token");
        csrfCookie.setCookieCustomizer(b -> b.secure(true).sameSite("Lax").httpOnly(false));
        http.csrf(csrf -> csrf
            .csrfTokenRepository(csrfCookie)
            .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler())
            .requireCsrfProtectionMatcher(request -> {
                String method = request.getMethod();
                if ("GET".equals(method) || "HEAD".equals(method)
                        || "OPTIONS".equals(method) || "TRACE".equals(method)
                        || request.getRequestURI().equals("/api/v1/auth/account-setup")
                        || request.getRequestURI().equals("/api/v1/auth/password-recovery")
                        || request.getRequestURI().equals("/api/v1/auth/password-reset")) return false;
                if (AuthTransport.mobile(request) && AuthTransport.validMobile(request)) return false;
                if (transportEnabled && (request.getRequestURI().equals("/api/v1/auth/login")
                    || request.getRequestURI().equals("/api/v1/auth/refresh")
                    || request.getRequestURI().equals("/api/v1/auth/logout"))) return true;
                return AuthTransport.hasAuthCookies(request);
            }));
        http.authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/account-setup",
                "/api/v1/auth/password-recovery", "/api/v1/auth/password-reset").permitAll()
            .requestMatchers(HttpMethod.GET, "/api/v1/auth/csrf").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/login", "/api/v1/auth/refresh").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/logout").permitAll()
            .requestMatchers("/actuator/health/**", "/v3/api-docs/**", "/swagger-ui/**").permitAll()
            .anyRequest().authenticated());
        BearerTokenResolver resolver = request -> {
            String route = request.getRequestURI();
            if (route.equals("/api/v1/auth/csrf")
                    || route.equals("/api/v1/auth/password-recovery")
                    || route.equals("/api/v1/auth/password-reset")
                    || route.equals("/api/v1/auth/login") || route.equals("/api/v1/auth/refresh")
                    || (route.equals("/api/v1/auth/logout") && !AuthTransport.mobile(request))) return null;
            String authorization = request.getHeader("Authorization");
            if (authorization != null) {
                if (AuthTransport.hasAuthCookies(request))
                    throw new OAuth2AuthenticationException(new OAuth2Error("invalid_token"));
                return new DefaultBearerTokenResolver().resolve(request);
            }
            return AuthTransport.cookie(request, AuthTransport.ACCESS);
        };
        http.oauth2ResourceServer(resource -> resource
            .authenticationEntryPoint(failures)
            .bearerTokenResolver(resolver).jwt(jwt -> jwt.decoder(jwtDecoder)));
        if (transportEnabled) {
            http.addFilterAfter(new BrowserCsrfProtectionFilter(csrfTokens.getObject(), locator,
                    logoutIdentity.getObject(), properties, failures),
                BearerTokenAuthenticationFilter.class);
        }
        return http.build();
    }
}
