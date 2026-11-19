# Local configuration

There is one canonical dotenv file per logical module:

| Module | Canonical file |
| --- | --- |
| API/Core | `services/api/.env` |
| AI | `services/ai/.env` |
| PostgreSQL bootstrap | `infra/local/postgres/.env` |
| Secure integration bootstrap | `infra/local/secure-integration/.env` |
| PI-05 planning metadata | `infra/local/pi05-isolated/.env` |
| Web | `apps/web/.env` |

Copy each adjacent `.env.example` once and keep the local files untracked.
Launchers parse literal `KEY=VALUE` entries; they do not execute dotenv files.
Core receives `DB_URL`, `DB_USERNAME`, and `DB_PASSWORD` only as a launch-time
mapping from PostgreSQL bootstrap settings. AI launchers map only the selected
process block to generic application names, so worker credentials are not
shared between HTTP, transcription, Knowledge, and Meeting Intelligence.

Run `./dev.sh doctor` before `./dev.sh up`. The development wrapper preserves
PostgreSQL volumes on `down`; it does not create certificates, provision
accounts, start PI-05, or start privileged Compose helpers. PI-05 remains
run-owned: prepare a private UUID-scoped manifest and use
`infra/local/pi05-isolated/generate_runtime.py` only after the approved run
inputs and certificates exist.

Never place database, broker, storage, AI provider, or private-key values in
`apps/web/.env`; Vite exposes `VITE_*` values to the browser bundle.
