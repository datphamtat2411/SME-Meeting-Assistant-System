# SPK-12 production approval evidence

## Decision record

- Engineering evidence: [SPK12_VERIFICATION.md](SPK12_VERIFICATION.md).
- Target preflight: [DIARIZATION_PREFLIGHT.md](DIARIZATION_PREFLIGHT.md).
- Production authorization: **NOT GRANTED**. Admission, Core worker capability and
  Python worker remain default-off. Monitoring is independently opt-in.
- Target access / approval references / reviewers / signatures / dates: **not
  supplied**. No canary, paid inference or production recording transfer performed.
- Engineering completion does not imply deployment validation or privacy approval.

## Evidence matrix

“Local evidence” proves repository behavior only. Each pending row requires an
account/deployment-specific evidence reference, accountable owner and authorized
decision. Roles below are required responsibilities, not appointed individuals.

| Area | Requirement | Actual available evidence | Remaining evidence / decision | Owner role / status |
|---|---|---|---|---|
| Provider privacy | Uploaded audio retention | Adapter uses Replicate Files API then Predictions; public API prediction cleanup is one hour by default (reviewed below). | Independent uploaded-file/backups retention and account settings, signed terms. | Privacy + provider owner / PENDING |
| Provider privacy | Provider logging | No meeting text or metadata is included in inference request; audio remains sensitive. | Provider/access/subprocessor log contents, retention, access control and audit terms. | Privacy / PENDING |
| Provider privacy | Training and secondary use | No organization-specific guarantee supplied. | Contractual no-training/secondary-use terms and applicable account controls. | Legal + privacy / PENDING |
| Provider privacy | Geography | No target region/account evidence supplied. | Processing/storage/subprocessor locations and lawful transfer review. | Legal + security / PENDING |
| Provider privacy | Deletion guarantees | Local temporary-source cleanup and immutable accepted-artifact retention are implemented. | Provider file/output/backup deletion timing, guarantees and verification. | Provider owner / PENDING |
| Provider privacy | Contractual terms | Public provider documentation is not organizational approval. | Current executed DPA/terms, retention/use exceptions, incident duties. | Legal / PENDING |
| Provider privacy | Organizational privacy approval | No reviewer/signature supplied. | Approved audio scope, organization-specific privacy/security decision. | Authorized privacy authority / PENDING |
| Infrastructure | Dedicated diarization IAM | Separate worker credential settings and local least-privilege boundary tests. | Effective target IAM/policy/credential separation, deny tests. | Platform / PENDING |
| Infrastructure | Source read permissions | Pinned source identity and bounded verified reads in worker tests. | Target source-only read policy, TLS and audit evidence. | Storage owner / PENDING |
| Infrastructure | Create-only result writes | Immutable result key, conditional create and uncertain-write reconciliation tested. | Backend conditional-write enforcement and effective deny overwrite/delete policy. | Storage owner / PENDING |
| Infrastructure | Immutable storage | V31 acceptance/evidence immutability and artifact preservation tested locally. | Target retention/Object Lock or equivalent policy and recovery ownership. | Storage owner / PENDING |
| Infrastructure | Dedicated credentials | Separate diarization credential configuration, no production secrets supplied. | Secret-manager references, rotation/least privilege, no shared ASR credentials. | Platform / PENDING |
| Infrastructure | Network / TLS | Real socket private attestation, mTLS identity/operation tests; secure local full-stack. | Target network isolation, CA/DNS trust, RabbitMQ/storage TLS. | Network + PKI / PENDING |
| Infrastructure | Certificate rotation | Startup validates TLS material and socket tests reject unauthorized identity. | Target renewal/reload/rolling strategy, expiry monitoring and rotation drill. | PKI / PENDING |
| Monitoring | Collector authorization | Monitoring-only URI SAN, GET-only route; worker/public/invalid identity denial tested. | Enrolled target collector, key custody and approval. | Monitoring + PKI / PENDING |
| Monitoring | Private scrape | Real Prometheus registry, default-off/fail-closed binding and socket tests. | Target scrape, private routing, public isolation evidence. | Platform / PENDING |
| Monitoring | Dashboard | Importable 12-panel Grafana JSON; actual queries parsed/evaluated by promtool. | Target import/datasource/screens and operator access. | Monitoring / PENDING |
| Monitoring | Alert routing | Executable recording/alert rules, sustained and transient fixtures; provisional thresholds. | Receiver ownership, routed notification test and threshold approval. | On-call + monitoring / PENDING |
| Monitoring | Multi-replica aggregation | Database reconstruction tests and two-replica max/dedup rule test. | Actual target labels and all replicas sharing the intended DB. | Monitoring / PENDING |
| Monitoring | Backlog visibility | V32 semantics, V33 measured plans/scaling/equivalence and oldest all-history age tests. | Target volume/plan review, backlog dashboard confirmation. | Core + DBA / PENDING |
| Monitoring | Recovery ownership | Exact-command/receipt/lease recovery and drain procedures documented. | Named Core, worker, DBA and incident/release owners. | Operations / PENDING |
| AI validation | Pinned model compatibility | Configured `konieshadow/speaker-diarization:c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20`; offline adapter/contract tests. | Authorized current provider/model live compatibility, input/output limits. | AI owner / PENDING |
| AI validation | Controlled live testing | No live calls authorized/performed; synthetic offline smoke only. | Approved scope/audio, spend limit, signed execution authorization and recorded results. | AI + privacy / PENDING |
| AI validation | Vietnamese quality | Synthetic fixtures establish protocol behavior, not accuracy. | Approved external Vietnamese meeting fixtures/annotations, overlap/noise coverage and evaluation. | AI evaluation / PENDING |
| AI validation | Speaker / unknown behavior | Normalization/alignment and durable count distributions tested offline. | Real speaker-count error/unknown behavior, human-review feedback, acceptance limits. | AI evaluation / PENDING |
| AI validation | Accuracy requirements | DER/speaker-count/unknown review requirements recorded in runbook. | Define approved thresholds/datasets/annotation methodology; evaluate and sign results. | Product + AI / PENDING |
| Release | Pre-deployment | Reproducible non-destructive target checklist and local mandatory gates. | Completed target evidence for every prerequisite; rendered default-off flags. | Release owner / PENDING |
| Release | Authorized canary | Restricted canary, bounds, abort and reconciliation procedures documented. | Explicit authorization, approved cohort, target measurements and owner. | Release authority / PENDING |
| Release | Go/no-go | No authorization supplied. | Review privacy/infrastructure/quality/monitoring evidence and record signed decision. | Authorized release authority / PENDING |
| Release | Rollback | Admission-off → intake drain → lifecycle reconciliation → compatible image; forward SQL retained. | Target rehearsal, previous compatible image, restored transcription and evidence retention. | Release + Core / PENDING |

## Provider policy assessment

Public pages reviewed read-only on **2026-11-07**; no account login, upload or
inference was performed. Terms/privacy pages identify their last update as
**2026-04-01**. This is an engineering source assessment, not acceptance of terms
or an organizational legal/privacy decision.

| Public source | Observed statement | Engineering assessment / limit |
|---|---|---|
| [Prediction data retention](https://replicate.com/docs/topics/predictions/data-retention) | API prediction input parameters, outputs/output files and logs are removed after one hour **by default**; web-interface prediction data is kept indefinitely. | Applies to documented prediction data; does not alone establish the independent uploaded Files API object's lifetime, backups or account overrides. Do not use the web UI with sensitive audio. |
| [HTTP API reference](https://replicate.com/docs/reference/http#predictions.get) | Repeats default one-hour API prediction input/output/log cleanup; prediction records expose `data_removed`. | Prediction cleanup is not proof of deletion of every transferred audio copy. The retrieved reference did not document a `files.create` retention guarantee. |
| [Terms §5.2](https://replicate.com/terms) | Customer-data license covers providing outputs/services, training customer derivative models and creating resultant data. | Do not infer either blanket no-training protection or unrelated foundation-model training permission from this alone; legal owner must resolve exact inference/account/model scope in the applicable agreement. |
| [Terms definitions and §5.5](https://replicate.com/terms) | Resultant data is aggregated/anonymized use information; terms allow its use to improve services/products and for other stated purposes. | Secondary-use assessment requires explicit organizational review and account-specific contractual terms. |
| [Privacy: Security & Retention](https://replicate.com/privacy) | Customer personal information is generally retained as necessary; legal/legitimate-interest exceptions and residual backup copies are described. | Not a numerical deletion guarantee for all audio/log/backup data; obtain specific scope and maximum durations. |
| [Privacy: disclosures/rights](https://replicate.com/privacy) | Describes affiliates/service providers, legal disclosures, deletion rights with legal/regulatory exceptions, and de-identified/aggregate use. | No approved processing geography, subprocessor scope, account-specific DPA or organizational approval is established by these pages. |

The implemented provider transfers uploaded audio outside the system. No applicable
executed agreement, organization-specific settings or privacy approval was supplied.
Audio retention, provider/access logging, training/secondary use, geography and
deletion guarantees therefore remain **unapproved / organization-specific evidence
pending**. No claim of provider-policy compliance or approved geography is made.

## Required completion record before release

For each matrix row capture an access-controlled evidence URI/hash, scope/account/
environment, verifier identity, actual outcome, timestamp and authorized decision.
Keep certificates, credentials, recordings and private policy documents outside
Git. Engineering has no authority to fill missing signatures or approve terms.

Current external classifications: **DEPLOYMENT_VALIDATION_PENDING** and
**EXTERNAL_APPROVAL_PENDING**. `READY_FOR_AUTHORIZED_CANARY` requires completed
target checks plus explicit canary authorization; `PRODUCTION_APPROVED` requires a
separate authorized human production decision. Neither is asserted by local tests.
