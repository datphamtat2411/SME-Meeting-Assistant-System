package com.sme.meetingassistant.api.authentication.security;

import jakarta.servlet.http.Cookie;
import java.util.Arrays;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Deny-by-default authenticated bearer API. Cookie authentication is NOT enabled yet.
 * P4-T05 adds session-bound browser CSRF validation and secure cookie transport.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class AccessSecurityConfiguration {
    @Bean
    JwtDecoder rs256JwtDecoder(RsaJwtKeys keys, SessionAuthority sessions) {
        return new LiveRs256JwtDecoder(keys, sessions);
    }

    @Bean
    SecurityFilterChain apiAccessSecurity(HttpSecurity http, JwtDecoder jwtDecoder) throws Exception {
        http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        // HSTS is exclusively managed by existing trusted-proxy-aware SecurityHeadersFilter.
        http.headers(headers -> headers.httpStrictTransportSecurity(hsts -> hsts.disable()));
        // Bearer is not an automatically attached browser credential. Keep CSRF active for
        // any future cookie-bearing request, including before P4-T05 cookie auth is shipped.
        http.csrf(csrf -> csrf.requireCsrfProtectionMatcher(request -> {
            String method = request.getMethod();
            if ("GET".equals(method) || "HEAD".equals(method)
                    || "OPTIONS".equals(method) || "TRACE".equals(method)) return false;
            Cookie[] cookies = request.getCookies();
            return cookies != null && Arrays.stream(cookies)
                .anyMatch(c -> c.getName().startsWith("__Host-") || c.getName().startsWith("__Secure-"));
        }));
        http.authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/v1/auth/account-setup").permitAll()
            .requestMatchers("/actuator/health/**", "/v3/api-docs/**", "/swagger-ui/**").permitAll()
            .anyRequest().authenticated());
        http.oauth2ResourceServer(resource -> resource.jwt(jwt -> jwt.decoder(jwtDecoder)));
        return http.build();
    }
}
