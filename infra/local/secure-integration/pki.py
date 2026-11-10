#!/usr/bin/env python3
"""CSR enrollment into the EXISTING approved Smallstep CA; no CA initialization.

All material paths must be outside the checkout. No live file replacement or service
restart is performed. Renew writes a separately validated candidate for operator activation.
"""
import argparse
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[3]
CLIENTS = {"core-client": "core-api", "worker-client": "ai-worker", "mi-client": "mi-worker",
           "knowledge-client": "knowledge-worker"}
ROLES = (*CLIENTS, "core-server", "broker-server", "storage-server")


def external(path, *, directory=False, secret=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve().is_relative_to(REPO):
        raise ValueError("material must be external and absolute")
    for component in (path, *path.parents):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("symlink material path")
        if info.st_mode & 0o022 and not (component == Path("/tmp") and info.st_mode & stat.S_ISVTX):
            raise ValueError("writable material path")
    info = path.stat()
    if directory:
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o007:
            raise ValueError("restricted runtime directory required")
    elif not stat.S_ISREG(info.st_mode) or info.st_size > 1048576 or info.st_nlink != 1:
        raise ValueError("invalid material file")
    elif secret and info.st_mode & 0o007:
        raise ValueError("unsafe key permissions")
    return path


def run(*args, input=None):
    return subprocess.run(args, input=input, check=True, capture_output=True, timeout=60).stdout


def public_key(cert):
    return run("openssl", "x509", "-in", str(cert), "-pubkey", "-noout")


def validate(role, cert, key, issuer, hostname=None, margin=3600):
    cert, key, issuer = external(cert), external(key, secret=True), external(issuer)
    data = cert.read_bytes()
    blocks = re.findall(rb"-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----", data)
    if not blocks or re.sub(rb"-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----", b"", data).strip():
        raise ValueError("invalid certificate chain PEM")
    for block in blocks:
        run("openssl", "x509", "-checkend", str(margin), "-noout", input=block)
    issuer_blocks = re.findall(rb"-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----", issuer.read_bytes())
    if not issuer_blocks:
        raise ValueError("issuer CA bundle required")
    for block in issuer_blocks:
        constraints = run("openssl", "x509", "-noout", "-ext", "basicConstraints", input=block)
        if b"CA:TRUE" not in constraints:
            raise ValueError("issuer trust bundle must contain CAs")
    purpose = "sslclient" if role in CLIENTS else "sslserver"
    command = ["openssl", "verify", "-no-CApath", "-no-CAstore", "-CAfile", str(issuer),
               "-untrusted", str(cert), "-purpose", purpose]
    if role not in CLIENTS:
        if not hostname or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", hostname):
            raise ValueError("explicit DNS hostname required")
        command += ["-verify_hostname", hostname]
    run(*command, str(cert))
    eku = run("openssl", "x509", "-in", str(cert), "-noout", "-ext", "extendedKeyUsage").decode()
    expected = "TLS Web Client Authentication" if role in CLIENTS else "TLS Web Server Authentication"
    if eku.splitlines()[1].strip() != expected:
        raise ValueError("certificate requires exact role EKU")
    san = run("openssl", "x509", "-in", str(cert), "-noout", "-ext", "subjectAltName").decode()
    if role in CLIENTS:
        uris = re.findall(r"URI:([^,\s]+)", san)
        if uris != [f"urn:sme:service:{CLIENTS[role]}"]:
            raise ValueError("wrong or ambiguous workload identity")
    elif hostname.lower() not in [x.lower() for x in re.findall(r"DNS:([^,\s]+)", san)]:
        raise ValueError("explicit matching DNS SAN required")
    if public_key(cert) != run("openssl", "pkey", "-in", str(key), "-pubout"):
        raise ValueError("certificate/key mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("csr", "enroll", "validate", "renew"))
    parser.add_argument("--role", required=True, choices=ROLES)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--hostname")
    parser.add_argument("--issuer", type=Path, help="workload issuer trust; required except csr")
    parser.add_argument("--ca-url", help="existing approved Smallstep HTTPS endpoint")
    parser.add_argument("--ca-root", type=Path, help="CA HTTPS trust, separate from workload issuer trust")
    parser.add_argument("--provisioner", help="CA-owner-approved provisioner; interactive authentication")
    parser.add_argument("--minimum-validity", type=int, default=3600)
    args = parser.parse_args()
    os.umask(0o077)
    directory = external(args.directory, directory=True)
    # Native RustFS file naming; other roles use consistent TLS filenames.
    cert = directory / ("rustfs_cert.pem" if args.role == "storage-server" else "tls.crt")
    key = directory / ("rustfs_key.pem" if args.role == "storage-server" else "tls.key")
    csr = directory / "request.csr"
    if args.minimum_validity < 60:
        raise ValueError("minimum validity must be at least 60 seconds")
    if args.role not in CLIENTS and (not args.hostname or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", args.hostname)):
        raise ValueError("DNS hostname required")
    if args.command == "csr":
        if any(p.exists() for p in (key, csr, cert)):
            raise ValueError("refusing to overwrite existing enrollment")
        identity = f"urn:sme:service:{CLIENTS[args.role]}" if args.role in CLIENTS else args.hostname
        san = "URI:" + identity if args.role in CLIENTS else "DNS:" + identity
        eku = "clientAuth" if args.role in CLIENTS else "serverAuth"
        # PKCS8, distinct role key. No secret or provisioner credential on command line.
        with tempfile.TemporaryDirectory(prefix=".csr-", dir=directory) as stage:
            stage = Path(stage)
            run("openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(stage / "key"))
            run("openssl", "req", "-new", "-key", str(stage / "key"), "-subj", "/CN=" + identity,
                "-addext", "subjectAltName=" + san, "-addext", "extendedKeyUsage=" + eku,
                "-addext", "keyUsage=critical,digitalSignature", "-out", str(stage / "csr"))
            # Exclusive installation, never overwrite a live key or another operator's CSR.
            for target, source in ((key, stage / "key"), (csr, stage / "csr")):
                with target.open("xb") as output:
                    output.write(source.read_bytes())
        print("PASS CSR prepared; CA owner must approve the requested SAN and exact EKU")
        return
    if args.command == "validate":
        validate(args.role, cert, key, args.issuer, args.hostname, args.minimum_validity)
        print("PASS certificate SAN/EKU/chain/validity/key/permissions")
        return
    url = urlsplit(args.ca_url or "")
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("explicit approved CA HTTPS URL required")
    root = external(args.ca_root)
    external(key, secret=True)
    if args.command == "enroll" and (cert.exists() or not args.provisioner):
        raise ValueError("new enrollment requires approved provisioner and absent certificate")
    if args.command == "renew":
        validate(args.role, cert, key, args.issuer, args.hostname, 60)
    candidate = directory / "candidate.crt"
    if candidate.exists():
        raise ValueError("inspect existing candidate before proceeding")
    if args.command == "enroll":
        # Interactive step authentication is deliberately inherited; never capture tokens/passwords.
        command = ["step", "ca", "sign", str(external(csr)), str(candidate), "--provisioner", args.provisioner]
    else:
        command = ["step", "ca", "renew", str(cert), str(key), "--mtls=false", "--out", str(candidate)]
    subprocess.run([*command, "--ca-url", args.ca_url, "--root", str(root)], check=True, timeout=180)
    os.chmod(candidate, 0o600)
    validate(args.role, candidate, key, args.issuer, args.hostname, args.minimum_validity)
    if args.command == "enroll":
        os.link(candidate, cert)  # atomic exclusive install
        candidate.unlink()
    print("PASS enrollment" if args.command == "enroll" else "PASS candidate validated; controlled activation/restart required")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, IndexError, TypeError, subprocess.SubprocessError):
        print("FAIL PKI configuration/enrollment/validation; inspect locally without sharing secrets", file=sys.stderr)
        raise SystemExit(1) from None
