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
  This produces **329 lines** out of 99,840 upstream candidates. Shorter
  entries cannot pass the existing 15-code-point minimum, so do not need
  to ship in the application. The previous 14 locally blocked values remain.
- Resource path: `src/main/resources/security/common-compromised-passwords.txt`.
  Check in the snapshot; never fetch it at runtime.
- A missing/partial blocklist **fails application initialization**, rather
  than allowing password setup/reset without the agreed controls.

To refresh, review the upstream candidate source and licensing, pin a new
SHA, regenerate the subset with exactly the above rules, diff with the
previous file, review false positives and run the focused + full API tests.
Do **not** download a floating `master` asset during startup or CI.

## Context-specific controls

Reject simple strings made of (up to two copies of) project/product,
organization identity, role and common department names plus small numeric
affixes. Examples: `SME Meeting Assistant 2026!`,
`department_manager_2027`, `Phong Nhan Su 2026!`.
The matching is anchored to **only** those simple patterns, not a blanket
ban on every strong passphrase containing a role or department word.

Because there is no tenant/organization-name field in the current canonical
PR3 identity model, this baseline uses the known SME/product/project labels
and common role/department words. Organization-specific names may be added
to the controlled list once they are defined as canonical product data;
avoid accepting caller-provided arbitrary names as policy authority.

## Test/acceptance gate

- Validate a long compromised value found in pinned SecLists (not in
  the previous inline set), including case/punctuation/Unicode-width variants.
- Reject product, role and department year/symbol variants.
- Preserve 15–128 Unicode-code-point, whitespace and no-composition rules.
- Real HTTP setup and recovery rejection must leave one-time tokens unused,
  existing account/password state unchanged and no reset audit record.
- Retest successfully with a strong password using the same authorization.
- Full PostgreSQL/Testcontainers integration and push/PR CI must pass.

**Data safety:** public wordlist items are known-weak candidates, **not**
raw application user credentials. No password values are put in audit
events, logs, analytics or outbound network requests.
