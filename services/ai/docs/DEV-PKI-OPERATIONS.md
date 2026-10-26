# Development PKI operations

This runbook installs **development-only** renewal of the AI Core server and its
dedicated readiness-probe certificate on a Linux/WSL host. Each already issued
certificate renews independently with its own existing key; this does not enroll
services, create a CA, rotate keys, or configure production PKI. Only server
certificate replacement requires a controlled container restart to reload TLS
material. Probe-only renewal and recovery never restart AI Core. Both lifecycles
use the same hourly timer and directory lock. No application API or image change
is needed.

## Material and trust boundaries

Keep these three locations separate, outside the repository:

```text
dev-pki/
  server/                  # the ONLY directory mounted into AI Core
    ai-server.crt          # PEM leaf followed by all required intermediates
    ai-server.key          # existing, unencrypted server private key
    client-ca.crt          # AI Core's client-authentication trust bundle
  operator/                # never mounted into AI Core
    issuer-root.crt        # CA that issued the server certificate
    intermediate.crt       # optional, if renew returns only the leaf
    probe-issuer-root.crt   # CA that issued the probe; can differ from server issuer
    probe-intermediate.crt  # optional, for the probe's client chain
    probe.crt              # separately issued development probe, clientAuth EKU
    probe.key              # probe's own private key
  backup/                  # renewal-user-owned, mode 0700, never mounted
    previous.crt           # created at activation, mode 0600
    previous-probe.crt      # separate probe recovery copy, mode 0600
```

**Issuer trust and client trust are distinct.** `issuer-root.crt` verifies the AI
server's chain and the server CA endpoint. `probe-issuer-root.crt` verifies the
probe's chain and its CA endpoint. `AI_TLS_CLIENT_CA_FILE` authenticates clients
connecting to AI Core; it need not be the server's issuer. The development probe
must be issued by a CA trusted there, have clientAuth EKU, and have exactly one
URI SAN matching `urn:sme:service:dev-pki-probe` (or the configured dedicated probe
identity). Readiness requires mTLS but no
application-operation grant. Do not grant the probe Core API's identity or reuse
Core API's client certificate/key. Do not give the renewer CA signing keys,
provisioner passwords, or Core API private keys.

The server leaf must have an explicit DNS/IP SAN matching the configured server
hostname and serverAuth EKU. Both private keys stay unchanged. For **each** leaf,
use a lifetime long enough for the schedule, threshold, and minimum remaining-
validity margin. For a typical 24-hour development leaf, an 8-hour renewal
threshold and 1-hour minimum margin leave room for an hourly timer. Probe and
server thresholds/margins can differ. Expired/untrusted current certificates fail
validation and require operator recovery or re-enrollment with the CA owner.

## Host prerequisites and access

- Linux with Bash, Python 3 standard library, OpenSSL 3, Smallstep `step`, ACL
  utilities (`getfacl`, `setfacl`), Docker CLI, curl, and user systemd. Offline
  template verification additionally uses `systemd-analyze`.
- Each CA must permit renewal with the existing certificate/key using
  `step ca renew --mtls=false`. This supports serverAuth-only leaves; it does not
  disable verification of the CA's HTTPS certificate. No insecure TLS option is
  used. Confirm this renewal policy with the development CA owner.
- The renewal user owns or can preserve both live certificates' UID/GID, mode,
  and ACL, can replace entries in `server/` and `operator/`, and can read its
  server and probe keys. Use user-owned mode-0700 operator/backup directories and
  restrictive keys.
  All paths must be absolute and normalized, with no symlink component or hard-
  linked material file. Group/other-writable material and directory paths are
  rejected (a root-owned sticky `/tmp` ancestor is allowed for isolated tests).
- Grant UID `10001` read access to the server files and traversal on the mounted
  directory as needed. For user-owned files, an administrator/operator can use
  `setfacl -m u:10001:rx /absolute/dev-pki/server` and
  `setfacl -m u:10001:r /absolute/dev-pki/server/{ai-server.crt,ai-server.key,client-ca.crt}`.
  Each certificate's named ACL entries are copied exactly to its replacement;
  this includes UID `10001` on the server certificate. Key and client-trust bytes
  and metadata are never changed. Do not grant AI Core access to probe material.
- The same user needs local Docker control for the allowlisted AI Core container.
  Docker-socket access is effectively host-administrator access; the script's
  container allowlist limits its own invocation, not the user's Docker privileges.
  Use a dedicated development operator account where practical. Never make the
  Docker socket world-writable.
- The expected hostname must resolve from both the renewal host (probe) and Core
  API's network. With a loopback-published port, configure development host DNS
  accordingly; use the certificate's DNS name, not an unverified alternate name.

## Directory mount and container settings

Use **one read-only directory bind mount**, not individual file mounts. Atomic
rename changes the certificate inode; an individual-file bind can keep exposing
the old inode even after restart. Keep only the three runtime materials in the
mounted directory (short-lived restricted staging files exist during renewal).
Never mount the operator or backup directory, an entire PKI tree, or a CA home.

Add these arguments to the restricted development Docker example in the README:

```sh
--mount type=bind,src=/absolute/dev-pki/server,dst=/run/secrets/ai-core,readonly \
-e AI_TLS_CERT_FILE=/run/secrets/ai-core/ai-server.crt \
-e AI_TLS_KEY_FILE=/run/secrets/ai-core/ai-server.key \
-e AI_TLS_CLIENT_CA_FILE=/run/secrets/ai-core/client-ca.crt
```

Keep `AI_ENVIRONMENT=development`, name the container `sme-ai-http`, and retain
the loopback-only port publication from the README. Core API must separately
trust the server issuer, verify the same server SAN, and present its own client
certificate. The existing direct-mTLS listener serves `/health/ready`; there is
no alternate plaintext probe port when TLS is configured.

`AI_TLS_*` values are **container paths only**. The host CLI reads only
`DEV_PKI_*` configuration; it does not load the application's `.env` file.

## External host configuration

Create `~/.config/sme-ai/dev-pki.env` owned by the renewal user, mode `0600`, in a
mode-`0700` directory. This is a systemd `EnvironmentFile`, not a shell script:
use literal absolute paths; `$HOME`, `${...}`, command substitutions, and shell
snippets are not expanded. Replace the example paths/hostname with development
values. Keep this file outside the repository and container.

```ini
DEV_PKI_CA_URL=https://ca.dev.example:9000
DEV_PKI_CA_ROOT_FILE=/absolute/dev-pki/operator/issuer-root.crt
DEV_PKI_CERT_FILE=/absolute/dev-pki/server/ai-server.crt
DEV_PKI_KEY_FILE=/absolute/dev-pki/server/ai-server.key
DEV_PKI_EXPECTED_HOSTNAME=ai-core.dev.example
DEV_PKI_RENEW_BEFORE=8h
DEV_PKI_MIN_VALIDITY_SECONDS=3600
DEV_PKI_BACKUP_DIR=/absolute/dev-pki/backup
DEV_PKI_CONTAINER=sme-ai-http
DEV_PKI_ALLOWED_CONTAINERS=sme-ai-http
DEV_PKI_DOCKER_STOP_GRACE_SECONDS=40
DEV_PKI_PROBE_URL=https://ai-core.dev.example:8000/health/ready
DEV_PKI_PROBE_CA_FILE=/absolute/dev-pki/operator/issuer-root.crt
DEV_PKI_PROBE_CERT_FILE=/absolute/dev-pki/operator/probe.crt
DEV_PKI_PROBE_KEY_FILE=/absolute/dev-pki/operator/probe.key
DEV_PKI_PROBE_ISSUER_ROOT_FILE=/absolute/dev-pki/operator/probe-issuer-root.crt
# Optional overrides; defaults are the server CA URL, threshold, and validity margin.
DEV_PKI_PROBE_CA_URL=https://ca.dev.example:9000
DEV_PKI_PROBE_RENEW_BEFORE=8h
DEV_PKI_PROBE_MIN_VALIDITY_SECONDS=3600
DEV_PKI_PROBE_EXPECTED_URI=urn:sme:service:dev-pki-probe
# Optional: include these intermediates in the served chain if CA returns only a leaf.
# DEV_PKI_INTERMEDIATE_FILE=/absolute/dev-pki/operator/intermediate.crt
# Optional: independent client chain; never append server intermediates to the probe.
# DEV_PKI_PROBE_INTERMEDIATE_FILE=/absolute/dev-pki/operator/probe-intermediate.crt
# Bounded defaults:
DEV_PKI_CA_TIMEOUT_SECONDS=60
DEV_PKI_PROBE_ATTEMPTS=10
DEV_PKI_PROBE_INTERVAL_SECONDS=1
DEV_PKI_PROBE_TIMEOUT_SECONDS=5
```

`DEV_PKI_PROBE_CA_FILE` verifies the **server**, not the probe's client issuer.
The new required `DEV_PKI_PROBE_ISSUER_ROOT_FILE` explicitly identifies the probe
issuer; use the same root path as the server only if both really share an issuer.
`DEV_PKI_PROBE_CA_URL` can target a different Smallstep CA; its default is
`DEV_PKI_CA_URL`. Use a separate server-verification bundle if the CA endpoint and
server use different trust chains. URLs must use HTTPS, without credentials,
query, or fragment; the probe must target the exact expected hostname and `/health/ready`. The
container target must exactly match an entry in `DEV_PKI_ALLOWED_CONTAINERS`
(comma-separated names, no spaces, flags, or shell commands).

`DEV_PKI_PROBE_EXPECTED_URI` defaults to `urn:sme:service:dev-pki-probe` and must
be `urn:sme:service:` followed by a lowercase service name with optional hyphen-
separated alphanumeric segments. `urn:sme:service:core-api` is rejected. Current,
staged, and recovery probe leaves must contain exactly this one URI SAN; missing,
duplicate, additional, or different URIs fail validation. DNS SANs or CN text
cannot stand in for a URI identity. No application-operation grant is needed.

Both `*_RENEW_BEFORE` settings accept a positive integer with `s`, `m`, `h`, or `d`,
at most 30 days. Both minimum-validity settings allow 60–604800 seconds; the probe
defaults to the server setting for each unless overridden. CA timeout is 1–300
seconds; probe attempts 1–30; interval 0–10 seconds; timeout per probe 1–30 seconds. Defaults are
shown above. `DEV_PKI_DOCKER_STOP_GRACE_SECONDS` allows 1–300 seconds and defaults
to **40 seconds**. Each Docker restart, including server rollback, has a command
deadline of the configured stop grace **plus 30 seconds** (70 seconds by default,
at most 330 seconds). Every external call is bounded. No systemd post-hook or
shell-command configuration is supported.

The backup directory must already exist, be owned by the renewal user with mode
`0700`, and lie outside the mounted directory. Credential and trust inputs must
not live in the backup directory; certificate/key paths must be distinct from one
another and from trust inputs. Always use the **same** backup directory for both
certificates: the script takes a nonblocking kernel `flock`
on that directory, stable across certificate replacement, with no lock-file
creation. `check` uses a shared lock, `renew` an exclusive lock. A busy result is
nonzero; the next timer run can retry. Do not add a probe-specific timer, cron job,
or second certificate writer.

## Install and migrate the existing ad hoc renewer

These are operator steps, **not performed by BUILD or tests**. Run as the intended
user, from the repository root, after reviewing paths and the existing setup.

For an existing installation of this versioned renewer, reuse
`sme-ai-dev-pki-renew.timer` and its existing backup directory. Stop the timer
while updating, let any active renewal finish, and install the updated CLI at the
same path. Add the required `DEV_PKI_PROBE_ISSUER_ROOT_FILE` to the host environment
file, confirm the current probe contains its complete client chain and expected
URI, and select any probe-specific overrides above. Then perform steps 4–5 below
and re-enable that **same** timer. No additional scheduler or application
environment change is required.

1. Identify the current `$HOME` script and user timer/service with
   `systemctl --user list-timers --all` and `systemctl --user cat <old-unit>`.
   Record their actual names and invocation. Prepare the new configuration first.
2. Disable the old timer and stop its service before enabling the new timer:
   `systemctl --user disable --now <old-timer>` and
   `systemctl --user stop <old-service>`. Confirm neither is active. Check for a
   cron entry or another scheduler invoking the old script. Archive the ad hoc
   script/config after migration; do not leave competing renewers or old
   unconditional Docker restart hooks enabled.
3. Install the versioned CLI and templates (the `.in` files require no rendering):

   ```sh
   install -d -m 0700 "$HOME/.local/libexec/sme-ai" "$HOME/.config/sme-ai"
   install -d -m 0755 "$HOME/.config/systemd/user"
   install -m 0700 services/ai/scripts/dev-pki-renew.sh "$HOME/.local/libexec/sme-ai/dev-pki-renew.sh"
   install -m 0644 services/ai/ops/systemd/sme-ai-dev-pki-renew.service.in "$HOME/.config/systemd/user/sme-ai-dev-pki-renew.service"
   install -m 0644 services/ai/ops/systemd/sme-ai-dev-pki-renew.timer.in "$HOME/.config/systemd/user/sme-ai-dev-pki-renew.timer"
   systemd-analyze --user verify "$HOME/.config/systemd/user/sme-ai-dev-pki-renew.service" "$HOME/.config/systemd/user/sme-ai-dev-pki-renew.timer"
   systemctl --user daemon-reload
   ```

4. Run read-only validation with the same environment file, without sourcing it:

   ```sh
   systemd-run --user --wait --pipe --collect \
     --property="EnvironmentFile=$HOME/.config/sme-ai/dev-pki.env" \
     "$HOME/.local/libexec/sme-ai/dev-pki-renew.sh" check
   ```

   Expect `status=not_due` or `status=due`, with independent `server=` and `probe=`
   fields. `check` validates both current chains against their explicit issuer
   roots, validity and key matches, the server SAN/serverAuth EKU, and the probe's
   exact URI/clientAuth EKU. It then calls only local
   `step certificate needs-renewal` for each certificate. It does not create files,
   request a CA renewal, invoke Docker/curl, or restart anything. All configuration, including
   recovery/probe settings, is required even for `check`.
5. Verify a controlled service run before enabling its timer:

   ```sh
   systemctl --user start sme-ai-dev-pki-renew.service
   systemctl --user status sme-ai-dev-pki-renew.service
   journalctl --user -u sme-ai-dev-pki-renew.service -n 30 --no-pager
   systemctl --user enable --now sme-ai-dev-pki-renew.timer
   systemctl --user list-timers sme-ai-dev-pki-renew.timer
   ```

   Two not-due certificates produce a successful no-op. A due probe renews first,
   with atomic replacement and authenticated readiness verification but **no
   restart**. A due server then renews, restarts, and verifies readiness with the
   current probe. A successful probe renewal is kept if server renewal fails;
   `status=partial` is nonzero and requires follow-up. Do not force
   expiry or touch live key material just to exercise renewal. If a migration
   check fails, leave the new timer disabled and resolve the reported reason;
   ensure only one chosen renewer is enabled afterward.

The user timer runs hourly with up to five minutes of jitter and `Persistent=true`
to catch missed calendar events when user systemd resumes. User-session lifecycle
and any administrator-approved lingering determine when user services run. WSL
shutdown stops execution; persistence does **not** renew certificates while WSL
or the host is offline. Catch-up cannot repair an already expired certificate.

## Renewal and failure semantics

`dev-pki-renew.sh check|renew` emits a sanitized single status line and returns
zero only for a successful check, a successful no-op, or all required renewals
completing successfully. Check/no-op/renewal results include independent
`server=due|not_due|renewed|failed|blocked` and `probe=due|not_due|renewed|failed`
fields. Renewal failures identify their `target`, `reason`, and `recovery`.
`step certificate needs-renewal` exits `0` for due, `1` for not due; **all other
codes, including `2` and `255`, are errors**, never a no-op.

| Status | Meaning / action |
| --- | --- |
| `status=not_due` | No live replacement and no restart; also used if CA returns identical certificate bytes. |
| `status=due` | Read-only check found either or both certificates due; see `server`/`probe`. |
| `status=renewed` | At least one replacement completed with verified mTLS HTTP 200 and `{"status":"ready"}`; restart occurred only for a server replacement. |
| `status=partial` | Probe renewal succeeded but later server renewal failed. Probe stays renewed; exit is nonzero. Apply the server's reported recovery action. |
| `status=invalid reason=...` | Configuration/current material/dependency/detection/lock failure; fix before retrying. |
| `status=failed ... recovery=not_needed` | Target renewal/staging/pre-activation failed; no target replacement or restart. A due server is `blocked` if probe renewal failed. |
| `status=failed ... recovery=restored` | Activation failed; previous valid target certificate restored and mTLS readiness succeeded. Only server recovery restarts. Still nonzero to surface the failed renewal. |
| `status=failed ... recovery=restored_unready` | Previous target certificate restored, but recovery readiness (or server restart) failed; operator intervention needed. |
| `status=failed ... recovery=manual` | Rollback unsafe or could not be installed; inspect current certificate/container and recover manually. |

The recovery values above also apply to a failed server within `status=partial`.

The script validates both current materials and detects both due states before
any write. A configuration, current-material, or detection error blocks activation.
It then handles due certificates in **probe, server** order under one exclusive
lock. Failure to renew/verify a due probe blocks server renewal, even if the old
probe was safely restored. A later server failure never rolls back an already
successful probe renewal.

For each due certificate, the script calls
`step ca renew <cert> <key> --mtls=false --out <stage>` with that target's explicit
CA URL/root and unchanged private key, and noninteractive overwrite of the
restricted staged file. It never asks the CA to write the live certificate.
Before activation it:

1. Rejects malformed/trailing PEM data and verifies expiry margin on every chain
   certificate, complete chain to the configured issuer root (not system roots),
   current validity, and leaf public key match to the unchanged target key. Server
   validation requires the explicit expected DNS/IP SAN and serverAuth EKU; probe
   validation requires clientAuth EKU and exactly one matching expected URI SAN.
   Each target's optional intermediate material is included in its **activated**
   staged chain, not merely supplied to verification.
2. Rechecks that live certificate/key/metadata have not changed concurrently.
   Atomically saves restricted `backup/previous.crt` (server) or
   `backup/previous-probe.crt` (probe) outside the mount, then preserves the live
   target's UID/GID, mode, and numeric ACL entries on the staged file.
3. Flushes and atomically renames the staged file on the live file's filesystem,
   then restarts the configured allowlisted container **only for server
   replacement**. Readiness uses the separate current probe certificate/key,
   server CA and DNS/IP verification, no proxy, no redirects or insecure fallback,
   and bounded retries. Probe staging, activation, and recovery stay outside the
   AI container mount.

CA errors or invalid staged material leave that target's live certificate
untouched and never restart. On activation/restart/readiness failure, automatic
rollback requires the backup to remain byte-identical to the saved certificate, still valid with a
verified chain and matching unchanged key, and the live candidate/metadata to be
unchanged by another writer. Rollback restores metadata using another same-
filesystem atomic rename, then attempts bounded readiness verification, with a
recovery restart **only for a server restoration**. Each target's previous backup
remains available after success or failure. Temporary files are cleaned on normal
exits and handled termination; SIGKILL/power loss can leave
a restricted staging file, and cannot guarantee recovery completion.

Diagnostics deliberately omit tool stderr, URLs, paths, and certificate/key
contents. Reasons such as `staged_validation`, `ca_renewal`, `restart_failed`,
`readiness_failed`, `metadata_preservation`, or `busy` identify the failing stage.
Inspect certificates with `openssl x509 -noout` and Docker/systemd status locally;
do not paste private keys, raw environment files, or tool credential output into
logs/issues. Fix unreachable CA/Docker, DNS, issuer trust, expired material, or ACL
access before retrying. Probe lifetime is now managed by this same timer; an
already expired probe still requires operator recovery or re-enrollment.

### Manual recovery

Disable the new timer and stop competing writers before recovery. For
`recovery=manual`, do not blindly copy a backup or restart repeatedly:

1. Identify the failed `target` and its live certificate. For the server, determine
   whether the container is serving it; for the probe, inspect the operator-only
   certificate path. Compare fingerprints/dates and use the separately authenticated
   readiness probe with server hostname verification. Keep a successfully renewed
   probe when investigating a partial server failure.
2. Validate the proposed recovery leaf and full chain against the **target issuer**
   root, not-before/not-after, and remaining margin. For the server, require the
   expected DNS/IP SAN and serverAuth EKU; for the probe, exactly the configured
   URI SAN and clientAuth EKU. Compare its public key with the target's existing
   private key without displaying that key. Do not restore an expired, modified,
   untrusted, or mismatching `previous.crt` / `previous-probe.crt`. Obtain a
   replacement from the appropriate CA owner if needed.
3. If safe, stage the validated chain in the **target** directory, preserve the live
   certificate's UID/GID, mode and full numeric `getfacl -cpn` ACL (including UID
   `10001` for the server), verify the metadata, flush, and rename atomically over
   the live path.
   Keep the key untouched and preserve the restricted backup outside the mount.
   Do not use a truncating write to the live file or an individual-file bind mount.
4. **Only after server replacement**, restart the intended AI Core container with
   the configured stop grace (40 seconds by default). Do not restart for probe-only
   recovery. Require authenticated mTLS `/health/ready` success. If recovery remains
   unready, keep the timer disabled and resolve the container/TLS failure with the development operator. Re-enable
   exactly one renewer only after a successful read-only check and controlled run.

## Focused, isolated verification

From `services/ai`:

```sh
uv run --locked pytest tests/unit/test_dev_pki_renew.py
```

The operations tests create temporary keys/certificates, substitute fake `step`,
`docker`, and `curl` commands, and validate systemd templates offline without
starting units. They cover independent due detection and probe-only renewal,
separate issuer chains, URI/SAN/EKU/validity/key checks, metadata/UID ACL preservation,
atomic replacement and separate backups, shared locking, cleanup, no-op/error/
partial-success semantics, bounded Docker stop grace/deadlines, and readiness/
recovery failures including probe recovery without restart. These tests do not
contact an active CA, Docker daemon, developer PKI/secrets, or a deployed AI service,
or modify user systemd configuration. Passing these tests establishes development
behavior,
**not production PKI readiness**, live provisioning, or uninterrupted availability.
