package com.sme.meetingassistant.api.config;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "app.http.security")
public class HttpSecurityProperties {

	private static final Set<String> BOUNDED_METHODS = Set.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");
	private static final Set<String> BOUNDED_REQUEST_HEADERS = Set.of("accept", "content-type", "authorization",
			"x-csrf-token", "idempotency-key", "if-match", "x-request-id");
	private static final Set<String> BOUNDED_EXPOSED_HEADERS = Set.of("etag", "location", "x-request-id");

	private Cors cors = new Cors();

	private Hsts hsts = new Hsts();

	public Cors getCors() {
		return this.cors;
	}

	public void setCors(Cors cors) {
		this.cors = cors == null ? new Cors() : cors;
	}

	public Hsts getHsts() {
		return this.hsts;
	}

	public void setHsts(Hsts hsts) {
		this.hsts = hsts == null ? new Hsts() : hsts;
	}

	public void validate(String environment) {
		this.cors.validate();
		this.hsts.validate();

		if (isProductionLike(environment)) {
			if (this.cors.getAllowedOrigins().isEmpty()) {
				throw new IllegalArgumentException(
						"app.http.security.cors.allowed-origins must contain an explicit HTTPS origin in production-like environments");
			}
			for (String origin : this.cors.getAllowedOrigins()) {
				URI parsedOrigin = parseOrigin(origin);
				if (!"https".equalsIgnoreCase(parsedOrigin.getScheme()) || isRestrictedHost(parsedOrigin.getHost())) {
					throw new IllegalArgumentException(
							"app.http.security.cors.allowed-origins must use non-local HTTPS origins in production-like environments");
				}
			}
		}
	}

	private static boolean isProductionLike(String environment) {
		return "production".equalsIgnoreCase(environment == null ? "" : environment.trim())
				|| "prod".equalsIgnoreCase(environment == null ? "" : environment.trim());
	}

	private static boolean isRestrictedHost(String host) {
		if (host == null) {
			return true;
		}
		String normalizedHost = host.toLowerCase(Locale.ROOT);
		return normalizedHost.equals("localhost") || normalizedHost.equals("localhost.")
				|| normalizedHost.equals("127.0.0.1") || normalizedHost.equals("0.0.0.0")
				|| normalizedHost.equals("::1") || normalizedHost.equals("0:0:0:0:0:0:0:1")
				|| normalizedHost.equals("::") || normalizedHost.equals("0:0:0:0:0:0:0:0");
	}

	private static URI parseOrigin(String origin) {
		try {
			URI parsedOrigin = new URI(origin);
			if ((!"http".equalsIgnoreCase(parsedOrigin.getScheme())
					&& !"https".equalsIgnoreCase(parsedOrigin.getScheme()))
					|| parsedOrigin.getHost() == null || parsedOrigin.getUserInfo() != null
					|| !parsedOrigin.getPath().isEmpty() || parsedOrigin.getQuery() != null
					|| parsedOrigin.getFragment() != null || origin.contains("*")) {
				throw invalidOrigin(origin);
			}
			return parsedOrigin;
		}
		catch (URISyntaxException exception) {
			throw invalidOrigin(origin);
		}
	}

	private static IllegalArgumentException invalidOrigin(String origin) {
		return new IllegalArgumentException(
				"app.http.security.cors.allowed-origins contains a malformed or wildcard origin: " + origin);
	}

	public static class Cors {

		private List<String> allowedOrigins = List.of();

		private List<String> allowedMethods = List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");

		private List<String> allowedHeaders = List.of("Accept", "Content-Type", "Authorization", "X-CSRF-Token",
				"Idempotency-Key", "If-Match", "X-Request-Id");

		private List<String> exposedHeaders = List.of("ETag", "Location", "X-Request-Id");

		private boolean allowCredentials = true;

		private Duration maxAge = Duration.ofMinutes(10);

		public List<String> getAllowedOrigins() {
			return this.allowedOrigins;
		}

		public void setAllowedOrigins(List<String> allowedOrigins) {
			this.allowedOrigins = copyNonBlankValues(allowedOrigins);
		}

		public List<String> getAllowedMethods() {
			return this.allowedMethods;
		}

		public void setAllowedMethods(List<String> allowedMethods) {
			this.allowedMethods = copyNonBlankValues(allowedMethods);
		}

		public List<String> getAllowedHeaders() {
			return this.allowedHeaders;
		}

		public void setAllowedHeaders(List<String> allowedHeaders) {
			this.allowedHeaders = copyNonBlankValues(allowedHeaders);
		}

		public List<String> getExposedHeaders() {
			return this.exposedHeaders;
		}

		public void setExposedHeaders(List<String> exposedHeaders) {
			this.exposedHeaders = copyNonBlankValues(exposedHeaders);
		}

		public boolean isAllowCredentials() {
			return this.allowCredentials;
		}

		public void setAllowCredentials(boolean allowCredentials) {
			this.allowCredentials = allowCredentials;
		}

		public Duration getMaxAge() {
			return this.maxAge;
		}

		public void setMaxAge(Duration maxAge) {
			this.maxAge = maxAge;
		}

		private void validate() {
			for (String origin : this.allowedOrigins) {
				parseOrigin(origin);
			}
			validateValues("allowed-methods", this.allowedMethods, BOUNDED_METHODS, true);
			validateValues("allowed-headers", this.allowedHeaders, BOUNDED_REQUEST_HEADERS, false);
			validateValues("exposed-headers", this.exposedHeaders, BOUNDED_EXPOSED_HEADERS, false);

			if (this.allowCredentials && this.allowedOrigins.isEmpty()) {
				throw new IllegalArgumentException(
						"app.http.security.cors.allowed-origins must be explicit when CORS credentials are enabled");
			}
			if (this.maxAge == null || this.maxAge.isNegative() || this.maxAge.compareTo(Duration.ofDays(1)) > 0) {
				throw new IllegalArgumentException(
						"app.http.security.cors.max-age must be a finite duration between zero and one day");
			}
		}

		private static void validateValues(String property, List<String> values, Set<String> allowedValues,
				boolean uppercase) {
			if (values == null || values.isEmpty()) {
				throw new IllegalArgumentException("app.http.security.cors." + property + " must not be empty");
			}
			for (String value : values) {
				String normalizedValue = uppercase ? value.toUpperCase(Locale.ROOT) : value.toLowerCase(Locale.ROOT);
				if (value.contains("*") || !allowedValues.contains(normalizedValue)) {
					throw new IllegalArgumentException(
							"app.http.security.cors." + property + " contains an unapproved or wildcard value: " + value);
				}
			}
		}

		private static List<String> copyNonBlankValues(List<String> values) {
			if (values == null || values.isEmpty()) {
				return List.of();
			}
			return values.stream().filter(value -> value != null && !value.isBlank()).map(String::trim).toList();
		}

	}

	public static class Hsts {

		private boolean enabled;

		private Duration maxAge = Duration.ofDays(365);

		private boolean includeSubdomains = true;

		private List<String> trustedProxies = List.of();

		private Set<String> normalizedTrustedProxies = Set.of();

		public boolean isEnabled() {
			return this.enabled;
		}

		public void setEnabled(boolean enabled) {
			this.enabled = enabled;
		}

		public Duration getMaxAge() {
			return this.maxAge;
		}

		public void setMaxAge(Duration maxAge) {
			this.maxAge = maxAge;
		}

		public boolean isIncludeSubdomains() {
			return this.includeSubdomains;
		}

		public void setIncludeSubdomains(boolean includeSubdomains) {
			this.includeSubdomains = includeSubdomains;
		}

		public List<String> getTrustedProxies() {
			return this.trustedProxies;
		}

		public void setTrustedProxies(List<String> trustedProxies) {
			this.trustedProxies = trustedProxies == null ? List.of()
					: trustedProxies.stream().map(value -> value == null ? null : value.trim()).toList();
		}

		public boolean isTrustedProxy(String remoteAddress) {
			String normalizedRemoteAddress = normalizeIpAddress(remoteAddress);
			return normalizedRemoteAddress != null && this.normalizedTrustedProxies.contains(normalizedRemoteAddress);
		}

		private void validate() {
			if (this.maxAge == null || this.maxAge.getSeconds() <= 0) {
				throw new IllegalArgumentException(
						"app.http.security.hsts.max-age must produce a positive whole number of seconds");
			}

			Set<String> normalizedProxies = new HashSet<>();
			for (String trustedProxy : this.trustedProxies) {
				String normalizedProxy = normalizeIpAddress(trustedProxy);
				if (normalizedProxy == null || trustedProxy == null || trustedProxy.isBlank()
						|| trustedProxy.contains("*")) {
					throw invalidTrustedProxy(trustedProxy);
				}
				normalizedProxies.add(normalizedProxy);
			}
			this.normalizedTrustedProxies = Set.copyOf(normalizedProxies);
		}

		private static String normalizeIpAddress(String value) {
			if (value == null || value.isBlank()) {
				return null;
			}
			String candidate = value.trim();
			if (candidate.indexOf(':') < 0) {
				if (!isIpv4Literal(candidate)) {
					return null;
				}
			}
			else if (!candidate.matches("[0-9A-Fa-f:.]+")) {
				return null;
			}
			try {
				return InetAddress.getByName(candidate).getHostAddress();
			}
			catch (java.net.UnknownHostException exception) {
				return null;
			}
		}

		private static boolean isIpv4Literal(String value) {
			String[] octets = value.split("\\.", -1);
			if (octets.length != 4) {
				return false;
			}
			for (String octet : octets) {
				if (octet.isEmpty() || !octet.chars().allMatch(Character::isDigit)) {
					return false;
				}
				try {
					if (Integer.parseInt(octet) > 255) {
						return false;
					}
				}
				catch (NumberFormatException exception) {
					return false;
				}
			}
			return true;
		}

		private static IllegalArgumentException invalidTrustedProxy(String value) {
			return new IllegalArgumentException(
					"app.http.security.hsts.trusted-proxies must contain only explicit IP addresses; invalid value: "
							+ value);
		}

	}

}
