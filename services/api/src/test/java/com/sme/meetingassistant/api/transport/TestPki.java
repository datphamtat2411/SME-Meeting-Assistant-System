package com.sme.meetingassistant.api.transport;

import java.nio.file.Files;
import java.nio.file.Path;

/** Ephemeral isolated PKI. Never used for shared development enrollment. */
public final class TestPki {
    public static void create(Path dir) throws Exception {
        run(dir, "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", "/CN=Isolated test CA", "-keyout", "ca.key", "-out", "ca.crt");
        run(dir, "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", "/CN=Untrusted test CA", "-keyout", "rogue-ca.key", "-out", "rogue-ca.crt");
        issue(dir, "server", "DNS:localhost", "serverAuth", "ca", false);
        issue(dir, "worker", "URI:urn:sme:service:ai-worker", "clientAuth", "ca", false);
        issue(dir, "core", "URI:urn:sme:service:core-api", "clientAuth", "ca", false);
        issue(dir, "mi", "URI:urn:sme:service:mi-worker", "clientAuth", "ca", false);
        issue(dir, "wrong", "URI:urn:sme:service:wrong", "clientAuth", "ca", false);
        issue(dir, "ambiguous", "URI:urn:sme:service:ai-worker,URI:urn:sme:service:core-api", "clientAuth", "ca", false);
        issue(dir, "malformed", "URI:urn:sme:service:AI_WORKER", "clientAuth", "ca", false);
        issue(dir, "missing-uri", "DNS:ai-worker", "clientAuth", "ca", false);
        issue(dir, "wrong-purpose", "URI:urn:sme:service:ai-worker", "serverAuth", "ca", false);
        issue(dir, "untrusted", "URI:urn:sme:service:ai-worker", "clientAuth", "rogue-ca", false);
        issue(dir, "expired", "URI:urn:sme:service:ai-worker", "clientAuth", "ca", true);
        issue(dir, "expired-server", "DNS:localhost", "serverAuth", "ca", true);
    }

    public static void issue(Path dir, String name, String san, String eku, String ca, boolean expired) throws Exception {
        run(dir, "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Test leaf",
            "-keyout", name + ".key", "-out", name + ".csr");
        Files.writeString(dir.resolve(name + ".ext"), "basicConstraints=critical,CA:FALSE\n"
            + "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=" + eku + "\nsubjectAltName=" + san + "\n");
        if (!expired) {
            run(dir, "openssl", "x509", "-req", "-in", name + ".csr", "-CA", ca + ".crt", "-CAkey", ca + ".key",
                "-CAcreateserial", "-days", "1", "-extfile", name + ".ext", "-out", name + ".crt");
        } else {
            Files.writeString(dir.resolve("index"), "");
            Files.writeString(dir.resolve("ca.cnf"), "[ca]\ndefault_ca=test\n[test]\ndatabase=index\nnew_certs_dir=.\n"
                + "serial=serial\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n");
            run(dir, "openssl", "ca", "-batch", "-config", "ca.cnf", "-create_serial", "-cert", ca + ".crt",
                "-keyfile", ca + ".key", "-startdate", "20200101000000Z", "-enddate", "20200102000000Z",
                "-extfile", name + ".ext", "-in", name + ".csr", "-out", name + ".crt", "-notext");
        }
    }

    static void run(Path directory, String... command) throws Exception {
        Process process = new ProcessBuilder(command).directory(directory.toFile())
            .redirectError(ProcessBuilder.Redirect.DISCARD).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        if (!process.waitFor(20, java.util.concurrent.TimeUnit.SECONDS) || process.exitValue() != 0) {
            process.destroyForcibly();
            throw new IllegalStateException("Test certificate generation failed");
        }
    }
}
