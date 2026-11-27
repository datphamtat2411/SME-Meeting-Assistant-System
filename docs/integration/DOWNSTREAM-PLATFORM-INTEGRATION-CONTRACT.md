# Wave 05 — downstream and platform integration

Entry baseline: `bada2ee6ea4bb18f9c87c8ff2b63c5ec4dfa5bf4` on pre-integration-develop.
Web presentation baseline: web/integration-rush. Requirements remain authoritative.

## Locked boundaries
- Minutes is an authorized canonical projection. No unconfirmed proposals
  may be represented as official. Web preserves the explicit non-official
  marker to warn and block export; Mobile rejects such a snapshot.
  Display metadata is optional v1 enrichment; use canonical assignee names
  before existing authorized meeting labels, with no extra directory lookup.
- Preserve schema version 1, source fingerprint and immutable export bytes.
  DisplayMetadata is intentionally excluded from the canonical fingerprint
  and renderer v1 bytes. Do not change renderer semantics under an existing
  renderer version. A name-enriched export needs an explicit versioned rendering
  decision; keep this requirement gap visible in INT-13.
- Preserve COMPLETE-only export admission, replay-only recovery, snapshot
  integrity, short-lived private download capabilities and existing historical
  artifact policy (Web current-only UI). Review draft exports and historical
  download policy in INT-13; no silent API contract change.
- Dashboard metrics use canonical official work, scope and configured
  business timezone; no client-side alternate metric authority.
- Preserve cookie/CSRF Web and bearer Mobile transport, current-session
  ownership, single-use setup capabilities, secure production configuration,
  isolated local debug policy and signed storage transport without Core tokens.
- Keep completed recording/import as the same offline processing class.
  Upload capabilities are capped at 15 minutes (RE08 security baseline);
  the 30-minute native transfer timeout is not the URL lifetime. Reauthorize
  current organizer/active-account state after admission locks and current
  content rights after signing an audio download.
  Preserve source, immutable upload/processing intent, recovery checkpoints,
  and explicit transcript review/admission. Do not bypass current authorization.
- Existing regression suites are retained. Live deployed devices, microphones,
  storage, AI and visual acceptance need separate evidence in INT-14/15.
- No new endpoint, migration, layout redesign, workflow weakening or
  compatibility retirement is authorized by Wave 05.
