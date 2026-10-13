package com.sme.meetingassistant.api.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Enumeration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

public class SecurityHeadersFilter extends OncePerRequestFilter implements Ordered {

	private static final int FILTER_ORDER = Ordered.HIGHEST_PRECEDENCE + 1;

	private final HttpSecurityProperties.Hsts hsts;

	public SecurityHeadersFilter(HttpSecurityProperties.Hsts hsts) {
		this.hsts = hsts;
	}

	@Override
	public int getOrder() {
		return FILTER_ORDER;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
			throws ServletException, IOException {
		applyHeaders(request, response);
		try {
			filterChain.doFilter(request, response);
		}
		finally {
			applyHeaders(request, response);
		}
	}

	private void applyHeaders(HttpServletRequest request, HttpServletResponse response) {
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
		response.setHeader("X-Frame-Options", "DENY");
		if (this.hsts.isEnabled() && isExternallySecure(request)) {
			String value = "max-age=" + this.hsts.getMaxAge().toSeconds();
			if (this.hsts.isIncludeSubdomains()) {
				value += "; includeSubDomains";
			}
			response.setHeader("Strict-Transport-Security", value);
		}
	}

	private boolean isExternallySecure(HttpServletRequest request) {
		return request.isSecure() || isTrustedForwardedHttps(request);
	}

	private boolean isTrustedForwardedHttps(HttpServletRequest request) {
		if (!this.hsts.isTrustedProxy(request.getRemoteAddr())) {
			return false;
		}

		Enumeration<String> forwardedProtocols = request.getHeaders("X-Forwarded-Proto");
		if (forwardedProtocols == null || !forwardedProtocols.hasMoreElements()) {
			return false;
		}
		String forwardedProtocol = forwardedProtocols.nextElement();
		if (forwardedProtocols.hasMoreElements() || forwardedProtocol == null
				|| !"https".equalsIgnoreCase(forwardedProtocol.strip())) {
			return false;
		}

		// Forwarded is not a supported protocol source; rejecting it avoids a second,
		// potentially contradictory protocol claim at this trust boundary.
		Enumeration<String> forwardedHeaders = request.getHeaders("Forwarded");
		return forwardedHeaders == null || !forwardedHeaders.hasMoreElements();
	}

}
