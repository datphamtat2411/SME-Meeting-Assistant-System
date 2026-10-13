package com.sme.meetingassistant.api.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
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
		if (this.hsts.isEnabled() && request.isSecure()) {
			String value = "max-age=" + this.hsts.getMaxAge().toSeconds();
			if (this.hsts.isIncludeSubdomains()) {
				value += "; includeSubDomains";
			}
			response.setHeader("Strict-Transport-Security", value);
		}
	}

}
