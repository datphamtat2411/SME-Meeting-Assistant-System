# M08 — Wave 03 secure Android account links

## Contract and deployment configuration

Build with an explicitly approved Web hostname via
`--dart-define=ACCOUNT_LINK_HOST=<approved-web-host>`, separately from
`API_BASE_URL`. The Flutter Gradle dart-defines property supplies the same
host to the generated Android manifest. No host means disabled account-link
handling, with browser guidance; malformed explicit host configuration fails.
There is no default production hostname or wildcard. Login and recovery
requests remain usable without this configuration.

The authoritative Dart parser accepts HTTPS at the exact configured host
(with an omitted port or explicit 443), no user information or query, the
exact paths `/account-setup` and `/reset-password` or existing compatibility
paths `/sign-up` and `/otp`, and exactly one fragment token parameter.
Form-style URL decoding occurs once; malformed encodings, whitespace/control
characters, invalid UTF-16, unexpected paths, and overlong values are rejected.
Raw URL size is bounded at 40,000 UTF-16 code units and decoded capability size
at 4,096. A parsed capability is not proof of backend authorization.

## Lifecycle and ownership

Android VIEW intents are acquired by the existing activity, not generic
Flutter routing. The transient native buffer holds at most four distinct raw
entries and drops the oldest on overflow; Dart takes each entry once in
arrival order. Activity recreation does not re-read the original intent.
The default Flutter deep-link handler is disabled. The application-scoped
receiver registers its listener before draining and rechecks after delivery.
Raw URL references are dropped after parsing. Dart retains at most one
validated pending candidate and one active ticket; equivalent path aliases
and decoded capability values deduplicate by a bounded, non-persistent
fingerprint. A terminal attempt does not auto-reopen on repeated delivery.

Signed-out initial links may open once after safe session restoration.
Other deliveries require deliberate continuation; authenticated links explain
that the capability may belong to another account. New links never replace
an active form or terminal outcome silently. Cancel the existing form or
finish the operation before continuing a deferred link. Active recording,
import, submission/upload and unsafe session transitions block entry.
The same guards are rechecked before credential mutation dispatch. Existing
session containment remains authoritative even when work is active.
Incompatible session navigation changes discard stale link context.
Deferred links are not restored from persistent storage or auto-opened on idle.

The account route reuses Wave 02 credential workflows; the host continues to
own non-sensitive outcomes when mandatory reset reconciliation replaces the
navigator. Retry deadlines are application-scoped, preserving the existing
60-second recovery acknowledgement cooldown and server Retry-After. HTTP 404
means service unavailable, not proof that a capability expired or was consumed.
Whole-link paste uses the same parser and entry rules, with no raw token input
in the production authentication flow. Clipboard access is deliberate.

## Android association and verification

Build example (synthetic host for configuration tests only):

```sh
flutter build apk --debug \
  --dart-define=API_BASE_URL=https://api.mobile-ci.invalid/api/v1 \
  --dart-define=ACCOUNT_LINK_HOST=meeting.mobile-ci.invalid
python3 tool/validate_account_link_manifest.py --host meeting.mobile-ci.invalid
```

For an unconfigured build omit ACCOUNT_LINK_HOST and run the same manifest
validator without --host. The configured manifest contains exact path
filters, verified HTTPS VIEW/DEFAULT/BROWSABLE intent configuration, and no
generic domain-wide filter. Native intent matching does not enforce the
default port when no explicit port is present; Dart enforces it.

Deployment owner must publish at
`https://<approved-web-host>/.well-known/assetlinks.json` (HTTPS, JSON,
no redirect), substituting the actual installed APK signing SHA-256 certificate:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "vn.sme.meetingassistant.sme_meeting_assistant",
      "sha256_cert_fingerprints": ["<actual-signing-certificate-sha256>"]
    }
  }
]
```

Use apksigner verify --print-certs on the installed build's APK or the
deployment-approved Play app-signing certificate (not the upload key).
Never publish a debug certificate on a production domain without approval.

On supported Android 12+ devices, inspect and request re-verification:

```sh
adb shell pm set-app-links --package vn.sme.meetingassistant.sme_meeting_assistant 0 all
adb shell pm verify-app-links --re-verify vn.sme.meetingassistant.sme_meeting_assistant
adb shell pm get-app-links vn.sme.meetingassistant.sme_meeting_assistant
```

Allow Android to complete asynchronous verification; inspect the actual host
state and user link-selection settings. For forced intent delivery tests use
synthetic, non-authorizing links only; an explicit component/package proves
delivery, not verified default handling. Verify cold launch, warm launch,
activity recreation, duplicate links, and normal email-client handoff without
forcing the component, including fragment preservation. Browser fallback
uses the existing Web callback; test with the app absent or link association
disabled. Never paste real capabilities into shell history, logs or screenshots.

## Acceptance status

Development implementation and regression tests are version controlled.
The final Mobile CI run is required to establish formatting, analysis,
Flutter tests, native JVM tests and both manifest configurations/builds.
The approved deployment host, production signing certificate, actual
Digital Asset Links publication, physical-device verification, SMTP and
live Core API acceptance remain external gates. Do not infer them from
synthetic URLs, mocked channels or a debug APK.
