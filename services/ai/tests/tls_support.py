"""Ephemeral test PKI only; never deployment certificate provisioning."""

import subprocess
from pathlib import Path


def create_test_pki(directory: Path) -> Path:
    def openssl(*args):
        subprocess.run(
            ["openssl", *args], cwd=directory, check=True, capture_output=True,
        )

    for ca in ("ca", "rogue-ca"):
        openssl(
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", f"/CN=Test {ca}", "-keyout", f"{ca}.key", "-out", f"{ca}.crt",
        )

    for name, san, ca, days, purpose in [
        ("server", "DNS:localhost,IP:127.0.0.1", "ca", "1", "serverAuth"),
        ("core-api", "URI:urn:sme:service:core-api", "ca", "1", "clientAuth"),
        ("other", "URI:urn:sme:service:other-service", "ca", "1", "clientAuth"),
        ("ambiguous", "URI:urn:sme:service:core-api,URI:urn:sme:service:other", "ca", "1", "clientAuth"),
        ("cn-only", "DNS:core-api", "ca", "1", "clientAuth"),
        ("expired", "URI:urn:sme:service:core-api", "ca", "-1", "clientAuth"),
        ("rogue", "URI:urn:sme:service:core-api", "rogue-ca", "1", "clientAuth"),
    ]:
        openssl(
            "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=core-api",
            "-keyout", f"{name}.key", "-out", f"{name}.csr",
        )
        (directory / f"{name}.ext").write_text(
            f"basicConstraints=critical,CA:FALSE\nextendedKeyUsage={purpose}\n"
            f"subjectAltName={san}\n"
        )
        if name == "expired":
            # Fixed past dates work across OpenSSL versions; negative -days does not.
            (directory / "index.txt").write_text("")
            (directory / "signing.cnf").write_text(
                "[ca]\ndefault_ca=test\n[test]\ndatabase=index.txt\n"
                "new_certs_dir=.\nserial=expired.serial\ndefault_md=sha256\n"
                "policy=policy\n[policy]\ncommonName=supplied\n[leaf]\n"
                "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth\n"
                "subjectAltName=URI:urn:sme:service:core-api\n"
            )
            openssl(
                "ca", "-batch", "-config", "signing.cnf", "-create_serial",
                "-cert", "ca.crt", "-keyfile", "ca.key", "-extensions", "leaf",
                "-startdate", "20200101000000Z", "-enddate", "20200102000000Z",
                "-in", "expired.csr", "-out", "expired.crt", "-notext",
            )
            continue
        openssl(
            "x509", "-req", "-in", f"{name}.csr", "-CA", f"{ca}.crt",
            "-CAkey", f"{ca}.key", "-CAcreateserial", "-days", days,
            "-extfile", f"{name}.ext", "-out", f"{name}.crt",
        )
    return directory
