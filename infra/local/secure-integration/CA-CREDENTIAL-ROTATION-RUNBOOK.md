# CA credential containment and rotation runbook

This is a sanitized, owner-operated procedure for the local Smallstep CA.
It is not an authorization to execute any step. Run it only in a separate
trusted terminal, never through OpenCode, and never place secret values in
commands, environment variables, shell history or incident chat.

## Current security boundary

- The compromised value was the initial CA password, used for CA key
  encryption and confirmed historically for `sme-dev-admin`.
- Direct password reuse by broker/storage or other provisioners is unresolved.
  Do not test reuse with the compromised value. Treat every JWK provisioner as
  requiring review.
- The CA is file/JWK configured with nine provisioners. The running CA needs
  the intermediate private key; the root private key is not needed for normal
  signing.
- Re-encrypting an active file does not invalidate an offline copy. A JWK
  key-pair rekey is required when old tokens or old encrypted-key copies must
  stop being accepted.

## Phase 0 — authorization and evidence

Obtain explicit approval for:

1. CA downtime and configuration mutation.
2. A new JWK key pair for `sme-dev-admin`; decide whether the same name is
   retained with a new `kid`, or a new provisioner name is used.
3. Review/rekey of broker, storage and all other JWK provisioners.
4. CA private-key password handling and any intermediate-key replacement.
5. Backup retention and destruction. Never delete incident logs as part of
   this procedure.

Preserve the incident artifacts first. Restrict the identified shell artifact
to mode `0600` without changing its bytes. If the artifact is unavailable at
the recorded path, stop and report that fact; do not guess another file.

## Phase 1 — isolated staging

In the trusted terminal:

```sh
umask 077
STAGE="$(mktemp -d /secure/ca-rotation.XXXXXX)"
chmod 700 "$STAGE"
```

Copy `ca.json`, the root/intermediate key files, and the active password-file
metadata into this directory using the CA owner's approved backup mechanism.
Do not copy them into Git, `/tmp`, OpenCode storage or an agent worktree.

Generate new owner-controlled password files:

```sh
openssl rand -base64 48 > "$STAGE/new-intermediate-password"
openssl rand -base64 48 > "$STAGE/new-root-password"
openssl rand -base64 48 > "$STAGE/new-sme-dev-admin-password"
chmod 600 "$STAGE"/new-*-password
```

The password contents must never be displayed.

## Phase 2 — provisioner JWK rekey, preferred containment

The installed CLI supports `step ca provisioner update --create
--password-file --ca-config`. Apply it to a staged copy, not the live CA:

```sh
cp --no-clobber "$STAGE/ca.json.before" "$STAGE/ca.json.new"

step ca provisioner update sme-dev-admin \
  --create \
  --password-file "$STAGE/new-sme-dev-admin-password" \
  --ca-config "$STAGE/ca.json.new"
```

This generates a new JWK key pair and `kid`; it does not require decrypting the
old private JWK and avoids writing a decrypted JWK to persistent storage.

For each other JWK provisioner, the owner must choose one of:

- rekey it with `--create` and a distinct new password;
- retain it only after proving, without exposing values, that its password was
  independently protected and was not reused; or
- disable/remove it through an owner-reviewed staged configuration change.

Compare the staged configuration with the original. For every provisioner not
intentionally changed, name, public key, `kid`, claims and templates must match.
For intentionally rekeyed provisioners, only the public key/`kid` and encrypted
private-key value should change.

If `--create` refuses an existing provisioner, do not force removal. Stop and
obtain approval for a staged new-name provisioner plus removal of the old one.

## Phase 3 — CA private-key encryption passwords

This is separate from JWK rekeying. `step crypto change-pass` is available in
Smallstep CLI `0.31.0`:

```sh
step crypto change-pass "$STAGE/intermediate_ca_key.before" \
  --password-file "$OPERATOR_AUTHORIZED_OLD_CA_KEY_FILE" \
  --new-password-file "$STAGE/new-intermediate-password" \
  --out "$STAGE/intermediate_ca_key.new"

step crypto change-pass "$STAGE/root_ca_key.before" \
  --password-file "$OPERATOR_AUTHORIZED_OLD_CA_KEY_FILE" \
  --new-password-file "$STAGE/new-root-password" \
  --out "$STAGE/root_ca_key.new"
```

The first command is needed for the online CA. The root key is not needed
online; re-encrypt it and move it to approved offline custody, or remove it
from the online volume after a verified backup.

If policy forbids even one owner-controlled offline use of the old password,
these in-place password changes are impossible. Do not substitute stdin,
environment variables or automation. Use a clean recovery backup with a
different known password, or obtain approval for a new intermediate/CA
hierarchy. That escalation changes certificate-chain operations.

## Phase 4 — controlled activation

Only after owner approval:

1. Stop only the local CA container.
2. Replace the staged `ca.json`, intermediate key and CA startup password in
   the CA volume using the deployment's owner-controlled, mode-preserving
   mechanism.
3. Update the host bind-mounted initialization secret so the compromised file
   is no longer retained as an active bootstrap input.
4. Start the CA and verify container health.

Do not use `docker compose down -v`, recreate the CA volume, alter the root or
intermediate certificates, or touch shared PKI.

## Phase 5 — verification and recovery

After startup, verify without issuing a certificate:

- CA health and HTTPS chain succeed.
- Root and intermediate certificate fingerprints are unchanged.
- The provisioner count and all unchanged templates/claims match the staged
  review.
- `sme-dev-admin` has the expected new `kid`.
- New JWK password decryption succeeds without printing the decrypted key.
- Existing shared certificate validation still passes.
- No issuance occurred during the maintenance window except a separately
  approved test.

If startup fails, stop the CA and restore the pre-rotation files from the
owner-controlled backup. This is temporary recovery only: the old credential
and any old encrypted-key copies remain compromised. Do not use rollback to
resume issuance without completing rotation.

## Effects

- Existing certificates remain valid when only key encryption or JWK key
  material changes; no revocation is implied.
- CA issuance and renewal are unavailable during the stop/start window.
- Existing certificate-authenticated renewal may continue after restart, but
  password-based enrollment using an affected provisioner requires its new
  password/key.
- Existing tokens signed by the old JWK may remain valid until expiry unless
  the provisioner key pair is rekeyed and the old public key is removed.
- Old offline copies of encrypted keys cannot be invalidated by changing the
  active file. They must be treated as compromised or the corresponding CA /
  provisioner key identity must be replaced.
