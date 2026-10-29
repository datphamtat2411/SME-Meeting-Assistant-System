package com.sme.meetingassistant.api.authentication.abuse;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Never accept forwarding headers unless the socket peer is on an explicit,
 * literal-IP trusted proxy list. For multi-hop paths, walk from the right and
 * return the first untrusted address. Malformed headers fail closed to the peer.
 */
@Component
public final class TrustedClientSource {
    private final Set<String> trusted;

    public TrustedClientSource(@Value("${app.auth.abuse.trusted-proxies:}") String configured) {
        this.trusted = Arrays.stream(configured.split(",", -1)).map(String::trim)
            .filter(v -> !v.isEmpty()).map(TrustedClientSource::literalIp)
            .collect(Collectors.toUnmodifiableSet());
    }

    public String from(HttpServletRequest request) {
        String peer = literalIp(request.getRemoteAddr());
        if (!trusted.contains(peer)) return peer;
        String header = request.getHeader("X-Forwarded-For");
        if (header == null || header.isBlank() || header.length() > 1024) return peer;
        String[] hops = header.split(",", -1);
        if (hops.length > 16) return peer;
        try {
            for (int i = hops.length - 1; i >= 0; i--) {
                String ip = literalIp(hops[i].trim());
                if (!trusted.contains(ip)) return ip;
            }
        } catch (IllegalArgumentException invalid) {
            return peer;
        }
        return peer;
    }

    public static String literalIp(String raw) {
        if (raw == null || raw.isBlank() || raw.length() > 45) {
            throw new IllegalArgumentException("Invalid client network address");
        }
        String address = raw.trim();
        // Parse numeric literals only, never resolve a caller-supplied hostname.
        boolean ipv6 = address.contains(":");
        if (ipv6) {
            if (!address.matches("[0-9a-fA-F:.]+") || !address.contains(":"))
                throw new IllegalArgumentException("Invalid client network address");
        } else {
            String[] parts = address.split("\\.", -1);
            if (parts.length != 4) throw new IllegalArgumentException("Invalid client network address");
            for (String part : parts) {
                if (!part.matches("[0-9]{1,3}") || Integer.parseInt(part) > 255)
                    throw new IllegalArgumentException("Invalid client network address");
            }
        }
        try {
            byte[] parsed = InetAddress.getByName(address).getAddress();
            if ((ipv6 && parsed.length != 16) || (!ipv6 && parsed.length != 4))
                throw new IllegalArgumentException("Invalid client network address");
            return InetAddress.getByAddress(parsed).getHostAddress();
        } catch (java.net.UnknownHostException invalid) {
            throw new IllegalArgumentException("Invalid client network address");
        }
    }
}
