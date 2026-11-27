package com.sme.meetingassistant.api.config;

import java.net.URI;
import java.util.Locale;

/** Validates browser destinations used by one-time account capabilities. */
public final class ApplicationPageUrlPolicy {

	private ApplicationPageUrlPolicy() {
	}

	public static URI validate(String configuredUrl, String environment, String pageName) {
		try {
			URI destination = URI.create(configuredUrl == null ? "" : configuredUrl);
			if (destination.getHost() == null || destination.getUserInfo() != null
					|| destination.getRawQuery() != null || destination.getRawFragment() != null) {
				throw invalid(pageName);
			}
			String scheme = destination.getScheme();
			if ("https".equalsIgnoreCase(scheme)) {
				return destination;
			}
			if (!"http".equalsIgnoreCase(scheme)
					|| !"development".equalsIgnoreCase(environment == null ? "" : environment.trim())
					|| !isLoopback(destination.getHost())) {
				throw invalid(pageName);
			}
			return destination;
		}
		catch (IllegalArgumentException invalid) {
			throw invalid(pageName);
		}
	}

	private static boolean isLoopback(String host) {
		String normalized = host.toLowerCase(Locale.ROOT);
		return normalized.equals("localhost") || normalized.equals("localhost.")
				|| normalized.equals("127.0.0.1") || normalized.equals("::1");
	}

	private static IllegalArgumentException invalid(String pageName) {
		return new IllegalArgumentException(
				(pageName == null || pageName.isBlank() ? "Application" : pageName)
						+ " destination must be an approved HTTPS page or a loopback HTTP development page");
	}
}
