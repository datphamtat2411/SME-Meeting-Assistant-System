package com.sme.meetingassistant.api.transport;

import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.Date;

/** Only called with a JSSE-verified peer, never HTTP input. */
public final class ServiceIdentity {
    private ServiceIdentity() {}

    public static String from(X509Certificate leaf) throws CertificateException {
        return from(leaf, Instant.now());
    }

    static String from(X509Certificate leaf, Instant now) throws CertificateException {
        leaf.checkValidity(Date.from(now));
        if (leaf.getBasicConstraints() >= 0 || leaf.getExtendedKeyUsage() == null
                || !leaf.getExtendedKeyUsage().contains(PemTls.CLIENT_AUTH)) throw new CertificateException("Client purpose required");
        var sans = leaf.getSubjectAlternativeNames();
        if (sans == null) throw new CertificateException("Service URI required");
        // Exactly one URI, no extra unrelated URI claims or duplicate identities.
        var uris = sans.stream().filter(san -> Integer.valueOf(6).equals(san.get(0))).map(san -> String.valueOf(san.get(1))).toList();
        if (uris.size() != 1 || !uris.getFirst().matches("urn:sme:service:[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
                || uris.getFirst().length() > 79) throw new CertificateException("Unambiguous service URI required");
        return uris.getFirst();
    }
}
