# F03 — Local common/compromised password blocklist

**Scope:** PR #3 account setup and PR #4 password recovery ONLY. No schema,
email, authentication transport, frontend, AI or external-password-service
changes. This is the baseline for SEC-PWD-001..007.

## Design decision

Both existing flows already inject `AccountSetupPasswordPolicy`; F03 replaces
its tiny inline-only check with one version-pinned bundled **offline list**.
Passwords and their hashes are never sent to a remote breach-check provider.
The original password string is still hashed unchanged by Argon2id, rather
than being normalized/truncated. Only a comparison copy is Unicode-NFKC
normalized, case-folded and (for catchable trivial punctuation variants)
stripped of nonletters/digits. No composition rules, ASCII-only checks or
periodic rotation have been added.

The list is an auditable **local common/previously exposed candidate set**.
It cannot prove that a password does NOT occur in any breach, and is not a
substitute for periodically reviewing a more comprehensive breach corpus.
The next blocklist update is a controlled security policy/data change.

### Source and data minimization

- Source: Daniel Miessler / SecLists, MIT licensed:
  `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`.
- **Pinned source revision**:
  `1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56`.
- Upstream:
  `https://github.com/danielmiessler/SecLists/blob/1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`
- License: `https://github.com/danielmiessler/SecLists/blob/1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56/LICENSE` (Copyright © 2018 Daniel Miessler; MIT)
- Selection: retain only lines with 15–128 Unicode code points, normalize
  NFKC, lower-case under Locale.ROOT, deduplicate and sort.
  This produces **329 source candidate lines** out of 99,840. Two
  `$hex[...]` entries encode `http://ads` and `http://www`, both shorter
  than 15 characters when decoded, so the reviewed bundled snapshot retains
  **327 entries**. The previous 14 locally blocked values remain.
- Resource path: `src/main/resources/security/common-compromised-passwords.txt`.
  Check in the snapshot; never fetch it at runtime.
- **Pinned UTF-8 SHA-256 resource digest:**
  `103e8b4890736ea3447ab53bce03381fc2697293a0339a5cfd83e28ff3f71cca`.
  This exact digest is verified at application startup before parsing.
  Missing, modified, truncated or corrupted resources fail initialization;
  entry count alone is not treated as an integrity guarantee.

To refresh: review upstream provenance/license and pin a specific new commit;
download the source for that commit outside the running application; decode
`$hex[...]` candidates before checking password length (do not include their
literal encoded form); retain candidates with 15–128 Unicode code points;
NFKC-normalize, lowercase using locale-independent semantics, deduplicate
and sort; preserve the reviewed header format. Diff and review the updated
snapshot for malformed/irrelevant records and false positives. Compute the
SHA-256 of the **exact final UTF-8 resource bytes**, update the pinned
`RESOURCE_SHA256` in the policy and this document together, then run focused
and complete CI tests. Do not silently update the resource, and do **not**
download a floating `master` asset at startup or in CI.

The 327-entry corpus is an intentionally **bounded baseline**. Passing the
check does not establish that a password was never leaked. Source selection,
coverage trade-offs and the release update cadence require explicit
product/security-owner approval; this document does not claim such approval.

## Context-specific controls

Reject simple strings made of (up to two copies of) project/product,
organization identity, role and common department names plus small numeric
affixes. Examples: `SME Meeting Assistant 2026!`,
`department_manager_2027`, `Phong Nhan Su 2026!`.
The common-password comparison uses NFKC case-folding and a punctuation-
collapsed copy. Context matching separately removes Unicode combining marks,
maps Vietnamese `đ` to `d`, and checks full-password, anchored numeric
variants. This rejects `Phòng Nhân Sự 2026!`, `Phòng Kế Toán 2026!` and
`SME Meeting Assistant System 2026!`, while allowing long passphrases that
only mention these words. The original accepted password is still passed
**unchanged** to Argon2id; no password normalization occurs at hashing.

Because there is no tenant/organization-name field in the current canonical
PR3 identity model, this baseline uses the known SME/product/project labels
and common role/department words. Organization-specific names may be added
to the controlled list once they are defined as canonical product data;
avoid accepting caller-provided arbitrary names as policy authority.

## Test/acceptance gate

- Validate a long compromised value found in pinned SecLists (not in
  the previous inline set), including case/punctuation/Unicode-width variants.
- Reject product, role and department year/symbol variants, including
  Vietnamese diacritics, `đ/Đ`, and the full product name.
- Keep valid passphrases with contextual terms and all allowed Unicode intact.
- Verify the exact pinned SHA-256 accepts the current resource and rejects
  byte modifications, truncation and missing data.
- Preserve 15–128 Unicode-code-point, whitespace and no-composition rules.
- Real HTTP setup and recovery rejection must leave one-time tokens unused,
  existing account/password state unchanged and no reset audit record.
- Retest successfully with a strong password using the same authorization.
- Full PostgreSQL/Testcontainers integration and push/PR CI must pass.

**Data safety:** public wordlist items are known-weak candidates, **not**
raw application user credentials. No password values are put in audit
events, logs, analytics or outbound network requests.
