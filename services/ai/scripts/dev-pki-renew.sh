#!/usr/bin/env bash
# Development-only Linux host tooling. Never source an environment file as shell code.
# Python's standard library supplies argument-safe execution, flock, and atomic rename.
set -euo pipefail
exec python3 - "$@" <<'PY'
import fcntl
import ipaddress
import json
import os
import re
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit


class Failure(Exception):
    pass


def command(args, *, data=None, timeout=30):
    try:
        process = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError:
        raise Failure("command_unavailable_or_timeout") from None
    try:
        out, err = process.communicate(input=data, timeout=timeout)
        return subprocess.CompletedProcess(args, process.returncode, out, err)
    except (subprocess.TimeoutExpired, Failure) as error:
        process.kill()
        process.communicate()
        if isinstance(error, Failure):
            raise
        raise Failure("command_unavailable_or_timeout") from None


def checked(args, *, data=None):
    result = command(args, data=data)
    if result.returncode:
        raise Failure("material_validation")
    return result.stdout


def safe_path(value, *, directory=False):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or str(path) != value:
        raise Failure("unsafe_path")
    for component in (*reversed(path.parents), path):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise Failure("symlink_path")
        if component != path or directory:
            if not stat.S_ISDIR(info.st_mode):
                raise Failure("unsafe_directory")
            # Shared /tmp is permitted only as a root-owned sticky ancestor.
            shared_tmp = component != path and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_mode & 0o022 and not shared_tmp:
                raise Failure("writable_directory")
        elif not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_nlink != 1:
            raise Failure("unsafe_file")
    return path


def setting(name, default=None):
    value = os.environ.get("DEV_PKI_" + name, default)
    if not value or any(ord(char) < 32 for char in value):
        raise Failure("configuration")
    return value


def number(name, default, lower, upper):
    value = setting(name, str(default))
    if not re.fullmatch(r"[0-9]+", value) or not lower <= int(value) <= upper:
        raise Failure("configuration_bounds")
    return int(value)


def threshold(name, default):
    value = setting(name, default)
    match = re.fullmatch(r"([1-9][0-9]*)([smhd])", value)
    if not match or int(match[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match[2]] > 2592000:
        raise Failure("configuration_threshold")
    return value


def https_url(value):
    try:
        url = urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment
                or url.port == 0 or any(char.isspace() for char in value)):
            raise ValueError
        return url
    except ValueError:
        raise Failure("configuration_url") from None


class Material:
    def __init__(self, name, cert_file, key_file, ca_url, root, intermediate, renew_before, minimum):
        self.name = name
        self.cert_file = cert_file
        self.key_file = key_file
        self.ca_url = ca_url
        self.root = root
        self.intermediate = intermediate
        self.renew_before = renew_before
        self.minimum = minimum


class Config:
    def __init__(self):
        self.ca_url = setting("CA_URL")
        https_url(self.ca_url)
        self.hostname = setting("EXPECTED_HOSTNAME")
        try:
            ipaddress.ip_address(self.hostname)
            self.identity_option = "-verify_ip"
        except ValueError:
            if (len(self.hostname) > 253 or not all(
                re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                for label in self.hostname.split(".")
            )):
                raise Failure("configuration_hostname") from None
            self.identity_option = "-verify_hostname"
        self.renew_before = threshold("RENEW_BEFORE", "8h")
        probe_renew_before = threshold("PROBE_RENEW_BEFORE", self.renew_before)
        self.minimum = number("MIN_VALIDITY_SECONDS", 3600, 60, 604800)
        probe_minimum = number("PROBE_MIN_VALIDITY_SECONDS", self.minimum, 60, 604800)
        self.ca_timeout = number("CA_TIMEOUT_SECONDS", 60, 1, 300)
        self.stop_grace = number("DOCKER_STOP_GRACE_SECONDS", 40, 1, 300)
        self.attempts = number("PROBE_ATTEMPTS", 10, 1, 30)
        self.interval = number("PROBE_INTERVAL_SECONDS", 1, 0, 10)
        self.probe_timeout = number("PROBE_TIMEOUT_SECONDS", 5, 1, 30)
        self.container = setting("CONTAINER")
        allowed = setting("ALLOWED_CONTAINERS").split(",")
        if (not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) for name in allowed)
                or self.container not in allowed):
            raise Failure("container_not_allowlisted")
        self.probe_url = setting("PROBE_URL")
        probe = https_url(self.probe_url)
        if (probe.hostname.lower() != self.hostname.lower() or probe.path != "/health/ready"):
            raise Failure("configuration_probe")
        self.probe_ca_url = setting("PROBE_CA_URL", self.ca_url)
        https_url(self.probe_ca_url)
        self.probe_expected_uri = setting("PROBE_EXPECTED_URI", "urn:sme:service:dev-pki-probe")
        if (not re.fullmatch(r"urn:sme:service:[a-z][a-z0-9]*(?:-[a-z0-9]+)*", self.probe_expected_uri)
                or self.probe_expected_uri == "urn:sme:service:core-api"):
            raise Failure("configuration_probe_identity")
        for name in ("CA_ROOT_FILE", "CERT_FILE", "KEY_FILE", "PROBE_CA_FILE",
                     "PROBE_CERT_FILE", "PROBE_KEY_FILE", "PROBE_ISSUER_ROOT_FILE"):
            setattr(self, name.lower(), safe_path(setting(name)))
        self.intermediate = None
        if os.environ.get("DEV_PKI_INTERMEDIATE_FILE"):
            self.intermediate = safe_path(setting("INTERMEDIATE_FILE"))
        probe_intermediate = None
        if os.environ.get("DEV_PKI_PROBE_INTERMEDIATE_FILE"):
            probe_intermediate = safe_path(setting("PROBE_INTERMEDIATE_FILE"))
        self.backup = safe_path(setting("BACKUP_DIR"), directory=True)
        info = self.backup.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise Failure("backup_permissions")
        mounted = self.cert_file.parent
        if (self.key_file.parent != mounted or self.cert_file == self.key_file
                or self.backup == mounted or mounted in self.backup.parents
                or self.backup in mounted.parents):
            raise Failure("configuration_layout")
        # Probe credentials and issuer material must stay outside the server-only mount.
        for path in (self.probe_cert_file, self.probe_key_file, self.ca_root_file,
                     self.intermediate, self.probe_ca_file, self.probe_issuer_root_file,
                     probe_intermediate):
            if path is not None and (path == mounted or mounted in path.parents):
                raise Failure("configuration_layout")
        credentials = (self.cert_file, self.key_file, self.probe_cert_file, self.probe_key_file)
        trust = tuple(path for path in (self.ca_root_file, self.probe_ca_file,
                      self.probe_issuer_root_file, self.intermediate, probe_intermediate)
                      if path is not None)
        if (len(set(credentials)) != len(credentials) or set(credentials).intersection(trust)
                or any(self.backup in path.parents for path in (*credentials, *trust))):
            raise Failure("configuration_layout")
        self.server = Material(
            "server", self.cert_file, self.key_file, self.ca_url, self.ca_root_file,
            self.intermediate, self.renew_before, self.minimum,
        )
        self.probe = Material(
            "probe", self.probe_cert_file, self.probe_key_file, self.probe_ca_url,
            self.probe_issuer_root_file, probe_intermediate, probe_renew_before, probe_minimum,
        )
        for tool in ("openssl", "step", "getfacl", "setfacl", "docker", "curl"):
            if shutil.which(tool) is None:
                raise Failure("missing_dependency")


PEM = re.compile(br"-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----")


def certificates(data):
    parts = PEM.findall(data)
    if not parts or PEM.sub(b"", data).strip():
        raise Failure("malformed_chain")
    return parts


def public_key(key):
    return checked(["openssl", "pkey", "-passin", "pass:", "-pubout", "-outform", "DER"], data=key)


def validate_chain(path, config, material, minimum):
    parts = certificates(path.read_bytes())
    for pem in parts:
        dates = checked(["openssl", "x509", "-noout", "-dates"], data=pem).decode("ascii")
        dates = dict(line.split("=", 1) for line in dates.splitlines())
        now = time.time()
        if (ssl.cert_time_to_seconds(dates["notBefore"]) > now
                or ssl.cert_time_to_seconds(dates["notAfter"]) <= now + minimum):
            raise Failure("certificate_validity")
    eku = checked([
        "openssl", "x509", "-noout", "-ext", "extendedKeyUsage",
    ], data=parts[0]).decode("ascii").partition("\n")[2]
    # Decode actual SAN entries, never infer types from a URI or other display text.
    decoded = ssl._ssl._test_decode_cert(str(path))
    usages = {value.strip() for value in eku.split(",")}
    if material.name == "probe":
        uris = [value for kind, value in decoded.get("subjectAltName", ()) if kind == "URI"]
        if uris != [config.probe_expected_uri] or "TLS Web Client Authentication" not in usages:
            raise Failure("san_or_client_auth")
        purpose, identity = "sslclient", []
    else:
        # verify_hostname alone permits CN fallback, so require the appropriate SAN type.
        san_type = "IP Address" if config.identity_option == "-verify_ip" else "DNS"
        if (not any(kind == san_type for kind, value in decoded.get("subjectAltName", ()))
                or "TLS Web Server Authentication" not in usages):
            raise Failure("san_or_server_auth")
        purpose, identity = "sslserver", [config.identity_option, config.hostname]
    checked([
        "openssl", "verify", "-CAfile", str(material.root), "-no-CApath", "-no-CAstore",
        "-purpose", purpose, *identity, "-untrusted", str(path),
    ], data=parts[0])
    pub_pem = checked(["openssl", "x509", "-pubkey", "-noout"], data=parts[0])
    pub_der = checked(["openssl", "pkey", "-pubin", "-outform", "DER"], data=pub_pem)
    if pub_der != public_key(material.key_file.read_bytes()):
        raise Failure("key_mismatch")


def acl(path):
    return checked(["getfacl", "-cpn", "--", str(path)])


def metadata(path):
    info = path.stat()
    return info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), acl(path)


def apply_metadata(path, saved):
    uid, gid, mode, entries = saved
    current = path.stat()
    if (current.st_uid, current.st_gid) != (uid, gid):
        os.chown(path, uid, gid)
    os.chmod(path, mode)
    checked(["setfacl", "--set-file=-", "--", str(path)], data=entries)
    if metadata(path) != saved:
        raise Failure("metadata_preservation")


def sync_file(path):
    with path.open("rb") as stream:
        os.fsync(stream.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def temporary(directory):
    fd, name = tempfile.mkstemp(prefix=".dev-pki-", dir=directory)
    os.close(fd)
    path = Path(name)
    try:
        # Remove inherited named/default ACLs; only activation restores the live file ACL.
        checked(["setfacl", "-b", "--", str(path)])
        os.chmod(path, 0o600)
        return path
    except (Failure, OSError):
        path.unlink(missing_ok=True)
        raise


def restart(config):
    result = command([
        "docker", "restart", "--time", str(config.stop_grace), config.container,
    ], timeout=config.stop_grace + 30)
    if result.returncode:
        raise Failure("restart_failed")


def probe(config):
    for attempt in range(config.attempts):
        try:
            result = command([
                "curl", "--disable", "--silent", "--show-error", "--fail", "--noproxy", "*",
                "--proto", "=https", "--tlsv1.2", "--cacert", str(config.probe_ca_file),
                "--cert", str(config.probe_cert_file), "--key", str(config.probe_key_file),
                "--connect-timeout", str(config.probe_timeout),
                "--max-time", str(config.probe_timeout), "--write-out", "\n%{http_code}",
                config.probe_url,
            ], timeout=config.probe_timeout + 2)
            body, code = result.stdout.strip().rsplit(b"\n", 1)
            if result.returncode == 0 and code == b"200" and json.loads(body) == {"status": "ready"}:
                return
        except (Failure, ValueError):
            pass
        if attempt + 1 < config.attempts:
            time.sleep(config.interval)
    raise Failure("readiness_failed")


def unchanged(material, original, key, saved):
    safe_path(str(material.cert_file))
    safe_path(str(material.key_file))
    if (material.cert_file.read_bytes() != original or material.key_file.read_bytes() != key
            or metadata(material.cert_file) != saved):
        raise Failure("concurrent_material_change")


def backup_certificate(config, material, data):
    destination = config.backup / ("previous-probe.crt" if material.name == "probe" else "previous.crt")
    if destination.exists() or destination.is_symlink():
        safe_path(str(destination))
        info = destination.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise Failure("backup_permissions")
    stage = temporary(config.backup)
    try:
        stage.write_bytes(data)
        sync_file(stage)
        os.replace(stage, destination)
        sync_directory(config.backup)
    finally:
        stage.unlink(missing_ok=True)
    return destination


def recover(config, material, backup, original, key, candidate, saved):
    stage = None
    restored = False
    try:
        safe_path(str(backup))
        if backup.read_bytes() != original:
            raise Failure("backup_changed")
        validate_chain(backup, config, material, 0)
        # Do not clobber concurrent operator changes, or restore against a changed key.
        unchanged(material, candidate, key, saved)
        stage = temporary(material.cert_file.parent)
        stage.write_bytes(original)
        apply_metadata(stage, saved)
        sync_file(stage)
        os.replace(stage, material.cert_file)
        restored = True
        sync_directory(material.cert_file.parent)
        if material.name == "server":
            restart(config)
        probe(config)
        return "restored"
    except (Failure, OSError):
        return "restored_unready" if restored else "manual"
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def renew(config, material, original, key, saved):
    stage = None
    replaced = False
    backup = None
    candidate = None
    try:
        stage = temporary(material.cert_file.parent)
        result = command([
            "step", "ca", "renew", str(material.cert_file), str(material.key_file), "--mtls=false",
            "--out", str(stage), "--force", "--ca-url", material.ca_url,
            "--root", str(material.root),
        ], timeout=config.ca_timeout)
        if result.returncode:
            raise Failure("ca_renewal")
        # Detect an operator's key change before validating the candidate against it.
        unchanged(material, original, key, saved)
        safe_path(str(stage))
        if material.intermediate:
            extra = certificates(material.intermediate.read_bytes())
            existing = certificates(stage.read_bytes())
            with stage.open("ab") as stream:
                for pem in extra:
                    if pem not in existing:
                        stream.write(b"\n" + pem + b"\n")
        try:
            validate_chain(stage, config, material, material.minimum)
        except (Failure, OSError):
            raise Failure("staged_validation") from None
        candidate = stage.read_bytes()
        unchanged(material, original, key, saved)
        if candidate == original:
            return "not_due", None, None
        backup = backup_certificate(config, material, original)
        apply_metadata(stage, saved)
        sync_file(stage)
        unchanged(material, original, key, saved)
        os.replace(stage, material.cert_file)
        replaced = True
        sync_directory(material.cert_file.parent)
        if material.name == "server":
            restart(config)
        probe(config)
        return "renewed", None, None
    except (Failure, OSError) as error:
        reason = str(error) if isinstance(error, Failure) else "activation_io"
        recovery = (recover(config, material, backup, original, key, candidate, saved)
                    if replaced else "not_needed")
        return "failed", reason, recovery
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def interrupted(signum, frame):
    raise Failure("interrupted")


def report(status, states, **details):
    fields = {"status": status, **states, **details}
    print(" ".join(f"{key}={value}" for key, value in fields.items()))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("check", "renew"):
        print("status=invalid reason=usage_expected_check_or_renew")
        return 2
    mode = sys.argv[1]
    lock = None
    states = {"server": "not_due", "probe": "not_due"}
    try:
        config = Config()
        # flock the existing backup directory: stable across certificate rename, no lock-file write.
        lock = os.open(config.backup, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(lock, (fcntl.LOCK_SH if mode == "check" else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("busy") from None
        snapshots = {}
        for material in (config.server, config.probe):
            snapshots[material.name] = (
                material.cert_file.read_bytes(), material.key_file.read_bytes(),
                metadata(material.cert_file),
            )
            validate_chain(material.cert_file, config, material, 0)
            unchanged(material, *snapshots[material.name])
        # Detect both before writing either; detection errors must never become a no-op.
        for material in (config.server, config.probe):
            result = command([
                "step", "certificate", "needs-renewal", str(material.cert_file),
                "--expires-in", material.renew_before,
            ])
            if result.returncode not in (0, 1):
                raise Failure("renewal_detection")
            states[material.name] = "due" if result.returncode == 0 else "not_due"
        if mode == "check":
            report("due" if "due" in states.values() else "not_due", states)
            return 0
        # Activate and verify the independent client first. A failed client renewal must
        # not trigger a server restart; a successful one survives later server failure.
        for material in (config.probe, config.server):
            if states[material.name] != "due":
                continue
            outcome, reason, recovery = renew(config, material, *snapshots[material.name])
            states[material.name] = outcome
            if outcome == "failed":
                if material.name == "probe" and states["server"] == "due":
                    states["server"] = "blocked"
                report("partial" if "renewed" in states.values() else "failed", states,
                       target=material.name, reason=reason, recovery=recovery)
                return 1
        report("renewed" if "renewed" in states.values() else "not_due", states)
        return 0
    except (Failure, OSError, ValueError):
        # No raw tool stderr, file paths, URLs, PEM, or private material in diagnostics.
        error = sys.exc_info()[1]
        reason = str(error) if isinstance(error, Failure) else "configuration_or_io"
        if "renewed" in states.values():
            report("partial", states, reason=reason, recovery="not_needed")
        else:
            print(f"status=invalid reason={reason}")
        return 1
    finally:
        if lock is not None:
            os.close(lock)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
PY
