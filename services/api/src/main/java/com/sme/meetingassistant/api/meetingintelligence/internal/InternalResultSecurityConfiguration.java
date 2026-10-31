package com.sme.meetingassistant.api.meetingintelligence.internal;

import com.sme.meetingassistant.api.authentication.transport.AuthSecurityFailureHandler;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Isolated, disabled-by-default machine authentication. A browser session or
 * regular user JWT never provides permission to submit internal results.
 * Credential must be a random base64url 32-byte token supplied via secret config.
 */
@Configuration(proxyBeanMethods = false)
public class InternalResultSecurityConfiguration {
    static final String PATH="/internal/api/v1/meeting-intelligence/**";
    static final String AUTHORITY="MI_RESULT_ACCEPT";

    @Bean
    @Order(1)
    @ConditionalOnProperty(prefix="app.mi.internal-result",name="enabled",havingValue="true")
    SecurityFilterChain internalResultChain(HttpSecurity http,
            AuthSecurityFailureHandler failures,
            @Value("${app.mi.internal-result.token:}") String token,
            @Value("${app.mi.internal-result.previous-token:}") String previousToken)
            throws Exception {
        byte[] current=validatedToken(token);
        byte[] previous=previousToken.isEmpty()?null:validatedToken(previousToken);
        if(previous!=null && MessageDigest.isEqual(current,previous))
            throw new IllegalArgumentException("Current and previous internal credentials must differ.");
        http.securityMatcher(PATH);
        http.sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        http.csrf(csrf->csrf.disable());
        http.exceptionHandling(e->e.authenticationEntryPoint(failures)
            .accessDeniedHandler(failures));
        http.authorizeHttpRequests(a->a.anyRequest().hasAuthority(AUTHORITY));
        http.addFilterBefore(new InternalCredentialFilter(current,previous,failures),
            UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    static byte[] validatedToken(String token) {
        if(token==null || !token.matches("[A-Za-z0-9_-]{43}"))
            throw new IllegalArgumentException(
                "Enabled internal result endpoint requires a base64url 256-bit credential.");
        try {
            byte[] decoded=java.util.Base64.getUrlDecoder().decode(token);
            if(decoded.length!=32 || !java.util.Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(decoded).equals(token)) throw new IllegalArgumentException();
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid internal result credential configuration.");
        }
        return token.getBytes(StandardCharsets.US_ASCII);
    }

    private static final class InternalCredentialFilter extends OncePerRequestFilter {
        private final byte[] current, previous;
        private final AuthSecurityFailureHandler failures;
        private InternalCredentialFilter(byte[] current,byte[] previous,AuthSecurityFailureHandler failures) {
            this.current=current.clone();
            this.previous=previous==null?null:previous.clone();
            this.failures=failures;
        }

        @Override protected void doFilterInternal(HttpServletRequest request,
                HttpServletResponse response,FilterChain chain)
                throws ServletException,IOException {
            String header=request.getHeader(HttpHeaders.AUTHORIZATION);
            byte[] supplied=header!=null && header.startsWith("Bearer ")
                && header.length()==50 // "Bearer " + 43 base64url chars
                ? header.substring(7).getBytes(StandardCharsets.US_ASCII):new byte[0];
            boolean valid=MessageDigest.isEqual(current,supplied)
                | (previous!=null && MessageDigest.isEqual(previous,supplied));
            if(!valid || request.getCookies()!=null || request.getHeaders(HttpHeaders.AUTHORIZATION)
                    .hasMoreElements() && java.util.Collections.list(
                    request.getHeaders(HttpHeaders.AUTHORIZATION)).size()!=1) {
                failures.commence(request,response,new BadCredentialsException("Invalid internal credential."));
                return;
            }
            try {
                SecurityContextHolder.getContext().setAuthentication(
                    new UsernamePasswordAuthenticationToken("MI_RESULT_ACCEPT",null,
                        List.of(new SimpleGrantedAuthority(AUTHORITY))));
                chain.doFilter(request,response);
            } finally {
                SecurityContextHolder.clearContext();
            }
        }
    }
}
