# Local configuration

There is one canonical dotenv file per logical module:

| Module | Canonical file |
| --- | --- |
| API/Core | `services/api/.env` |
| AI | `services/ai/.env` |
| PostgreSQL bootstrap | `infra/local/postgres/.env` |
| Secure integration bootstrap | `infra/local/secure-integration/.env` |
| PI-05 orchestration metadata | `infra/local/pi05-isolated/.env` |
| Web | `apps/web/.env.local` |

Copy each adjacent `.env.example` once to the module's canonical local file and
keep the local files untracked. Vite's active Web local override is
`apps/web/.env.local`.
Launchers parse literal `KEY=VALUE` entries; they do not execute dotenv files.
Core receives `DB_URL`, `DB_USERNAME`, and `DB_PASSWORD` only as a launch-time
mapping from PostgreSQL bootstrap settings. AI launchers map only the selected
process block to generic application names, so worker credentials are not
shared between HTTP, transcription, Knowledge, and Meeting Intelligence.

Run `./dev.sh doctor` before `./dev.sh up`. The development wrapper starts only
the normal secure-integration dependency project and host Core/AI processes. It
preserves PostgreSQL/secure dependency volumes on `down`, does not create
certificates, provision accounts, start PI-05, or start privileged Compose
helpers.

Use `./dev.sh migrate` to inventory pre-refactor split dotenv files. The check
is read-only, reports only paths/counts, and never prints values or overwrites
an existing file. Merge legacy values into the canonical file manually, then
keep the legacy file out of future launches.

PI-05 `.env` contains only run selection and non-secret orchestration metadata.
`./dev.sh admit` performs the separate fresh-project admission check. `./dev.sh
e2e` requires a prepared, already-running UUID-scoped project and validates its
private generated process files and Docker ownership/readiness; it does not run
fresh-project admission. Prepare the private manifest and generated files only
after approved run inputs and certificates exist.

Never place database, broker, storage, AI provider, or private-key values in
`apps/web/.env`; Vite exposes `VITE_*` values to the browser bundle.

## Progressive meeting intelligence

The existing intelligence stage, budget, and private worker settings still
control which stages run. Transcript edits enqueue derived-only work; the Core
scheduler polls pending revisions using `app.media.intelligence.refresh-poll-ms`
(default `10000`). `APP_MEDIA_INTELLIGENCE_REGENERATION_ENABLED` controls the
explicit regeneration endpoint, independent of automatic edit synchronization.

Assistant generation still requires configured provider access and the existing
private Core–AI operation grants, including source verification. Its HTTP
process can serve conversation and current canonical context while retrieval
dependencies recover. For a rollout that should add previously excluded
uncertain segments to existing indexed meetings, reconcile/rebuild through the
existing knowledge generation administration rather than dropping the collection.
