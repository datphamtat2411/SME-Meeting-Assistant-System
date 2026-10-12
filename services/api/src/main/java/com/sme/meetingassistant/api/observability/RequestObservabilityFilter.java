package com.sme.meetingassistant.api.observability;

import com.sme.meetingassistant.api.config.RuntimeProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestObservabilityFilter extends OncePerRequestFilter {

	private static final Logger LOGGER = LoggerFactory.getLogger(RequestObservabilityFilter.class);
	private static final String UNMATCHED_ROUTE = "unmatched";

	private final RuntimeProperties runtimeProperties;

	public RequestObservabilityFilter(RuntimeProperties runtimeProperties) {
		this.runtimeProperties = runtimeProperties;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
			throws ServletException, IOException {
		String requestId = resolveRequestId(request);
		String previousRequestId = RequestIdContext.currentRequestId();
		long startedAt = System.nanoTime();
		Throwable failure = null;

		request.setAttribute(RequestIdContext.REQUEST_ID_ATTRIBUTE, requestId);
		RequestIdContext.setCurrentRequestId(requestId);
		response.setHeader(RequestIdContext.HEADER_NAME, requestId);

		try {
			filterChain.doFilter(request, response);
		}
		catch (IOException | ServletException exception) {
			failure = exception;
			throw exception;
		}
		catch (RuntimeException | Error exception) {
			failure = exception;
			throw exception;
		}
		finally {
			response.setHeader(RequestIdContext.HEADER_NAME, requestId);
			try {
				logCompletion(request, response, requestId, startedAt, failure);
			}
			finally {
				RequestIdContext.restore(previousRequestId);
				request.removeAttribute(RequestIdContext.REQUEST_ID_ATTRIBUTE);
			}
		}
	}

	private String resolveRequestId(HttpServletRequest request) {
		String suppliedRequestId = request.getHeader(RequestIdContext.HEADER_NAME);
		if (isTrustedPeer(request) && isCanonicalUuid(suppliedRequestId)) {
			return suppliedRequestId;
		}
		return UUID.randomUUID().toString();
	}

	private boolean isTrustedPeer(HttpServletRequest request) {
		String remoteAddress = request.getRemoteAddr();
		return remoteAddress != null
				&& this.runtimeProperties.getRequestId().getTrustedProxies().contains(remoteAddress);
	}

	private static boolean isCanonicalUuid(String value) {
		if (value == null) {
			return false;
		}
		try {
			return UUID.fromString(value).toString().equals(value);
		}
		catch (IllegalArgumentException exception) {
			return false;
		}
	}

	private static void logCompletion(HttpServletRequest request, HttpServletResponse response, String requestId,
			long startedAt, Throwable failure) {
		int status = response.getStatus();
		String outcome = failure != null || status >= 400 ? "ERROR" : "SUCCESS";
		long durationMillis = (System.nanoTime() - startedAt) / 1_000_000;

		LOGGER.atInfo()
				.addKeyValue("method", request.getMethod())
				.addKeyValue("route", route(request))
				.addKeyValue("status", status)
				.addKeyValue("outcome", outcome)
				.addKeyValue("durationMs", durationMillis)
				.log("HTTP request completed");
	}

	private static String route(HttpServletRequest request) {
		Object routePattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
		if (routePattern instanceof String pattern && !pattern.isBlank()) {
			return pattern;
		}
		return UNMATCHED_ROUTE;
	}

}
