package com.sme.meetingassistant.api.transport;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/** Explicit per-transport trust. No system trust or process-wide TLS changes. */
public final class PemTls {
    private PemTls() {}
    public static final String CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
    public static final String SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

    static String read(Path path, boolean secret) throws Exception {
        if (path == null || !path.isAbsolute() || Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > 1048576) {
            throw new IllegalStateException("Invalid TLS material");
        }
        var mode = Files.getPosixFilePermissions(path);
        if (mode.contains(PosixFilePermission.GROUP_WRITE) || mode.contains(PosixFilePermission.OTHERS_WRITE)
                || (secret && (mode.contains(PosixFilePermission.OTHERS_READ)
                    || mode.contains(PosixFilePermission.OTHERS_EXECUTE)))) {
            throw new IllegalStateException("Unsafe TLS material permissions");
        }
        return Files.readString(path);
    }

    public static List<X509Certificate> certificates(Path path) throws Exception {
        String pem = read(path, false);
        var matcher = Pattern.compile("-----BEGIN CERTIFICATE-----[\\sA-Za-z0-9+/=]+-----END CERTIFICATE-----").matcher(pem);
        var result = new ArrayList<X509Certificate>();
        int end = 0;
        var factory = CertificateFactory.getInstance("X.509");
        while (matcher.find()) {
            if (!pem.substring(end, matcher.start()).isBlank()) throw new IllegalStateException("Invalid certificate PEM");
            var certificate = (X509Certificate) factory.generateCertificate(
                new ByteArrayInputStream(matcher.group().getBytes(java.nio.charset.StandardCharsets.US_ASCII)));
            result.add(certificate); end = matcher.end();
        }
        if (result.isEmpty() || !pem.substring(end).isBlank()) throw new IllegalStateException("Invalid certificate PEM");
        return List.copyOf(result);
    }

    static PrivateKey privateKey(Path path, String algorithm) throws Exception {
        String pem = read(path, true).strip();
        if (!pem.matches("-----BEGIN PRIVATE KEY-----[\\sA-Za-z0-9+/=]+-----END PRIVATE KEY-----")) {
            throw new IllegalStateException("TLS keys must be unencrypted PKCS8 PEM");
        }
        byte[] bytes = Base64.getDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "").replaceAll("\\s", ""));
        try { return KeyFactory.getInstance(algorithm).generatePrivate(new PKCS8EncodedKeySpec(bytes)); }
        finally { java.util.Arrays.fill(bytes, (byte) 0); }
    }

    public static KeyStore trustStore(Path ca) throws Exception {
        var store = KeyStore.getInstance("PKCS12"); store.load(null, null);
        int index = 0;
        for (var cert : certificates(ca)) {
            cert.checkValidity();
            if (cert.getBasicConstraints() < 0) throw new IllegalStateException("Trust bundle must contain only CAs");
            store.setCertificateEntry("ca-" + index++, cert);
        }
        return store;
    }

    public static X509TrustManager trustManager(Path ca) throws Exception {
        var factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init(trustStore(ca));
        return (X509TrustManager) factory.getTrustManagers()[0];
    }

    static KeyStore identity(Path cert, Path key, Path issuerCa, String purpose, String expected) throws Exception {
        var chain = certificates(cert);
        var leaf = chain.getFirst();
        for (var item : chain) item.checkValidity();
        if (leaf.getBasicConstraints() >= 0 || leaf.getExtendedKeyUsage() == null
                || !leaf.getExtendedKeyUsage().equals(List.of(purpose))) {
            throw new IllegalStateException("Certificate role must have exactly the required EKU");
        }
        var verifier = trustManager(issuerCa);
        if (CLIENT_AUTH.equals(purpose)) {
            verifier.checkClientTrusted(chain.toArray(X509Certificate[]::new), leaf.getPublicKey().getAlgorithm());
            if (!expected.equals(ServiceIdentity.from(leaf))) throw new IllegalStateException("Incorrect service identity");
        } else {
            String serverAuthType = switch (leaf.getPublicKey().getAlgorithm()) {
                case "EC" -> "ECDHE_ECDSA";
                case "RSA" -> "ECDHE_RSA";
                default -> throw new IllegalStateException("Unsupported TLS server key algorithm");
            };
            verifier.checkServerTrusted(chain.toArray(X509Certificate[]::new), serverAuthType);
            var sans = leaf.getSubjectAlternativeNames();
            if (expected == null || sans == null || sans.stream().noneMatch(san -> Integer.valueOf(2).equals(san.get(0))
                    && expected.equalsIgnoreCase(String.valueOf(san.get(1))))) {
                throw new IllegalStateException("Private server requires its exact DNS SAN");
            }
        }
        var privateKey = privateKey(key, leaf.getPublicKey().getAlgorithm());
        String algorithm = switch (privateKey.getAlgorithm()) {
            case "RSA" -> "SHA256withRSA";
            case "EC" -> "SHA256withECDSA";
            default -> throw new IllegalStateException("Unsupported TLS key algorithm");
        };
        var signature = Signature.getInstance(algorithm);
        byte[] challenge = new byte[32]; new java.security.SecureRandom().nextBytes(challenge);
        signature.initSign(privateKey); signature.update(challenge); byte[] signed = signature.sign();
        signature.initVerify(leaf.getPublicKey()); signature.update(challenge);
        if (!signature.verify(signed)) throw new IllegalStateException("Certificate and key do not match");
        var store = KeyStore.getInstance("PKCS12"); store.load(null, null);
        store.setKeyEntry("workload", privateKey, new char[0], chain.toArray(java.security.cert.Certificate[]::new));
        return store;
    }

    public static SSLContext clientContext(Path cert, Path key, Path issuerCa, Path serverCa, String expected) {
        try {
            var identity = identity(cert, key, issuerCa, CLIENT_AUTH, expected);
            var keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keys.init(identity, new char[0]);
            var context = SSLContext.getInstance("TLS");
            context.init(keys.getKeyManagers(), new javax.net.ssl.TrustManager[]{trustManager(serverCa)}, null);
            return context;
        } catch (Exception e) { throw new IllegalStateException("Invalid outbound mTLS configuration"); }
    }
}
