# Integration Task 02 — Shared storage, configuration and dependency contracts

Branch: `integration/dashboard-export-into-develop`

## Contract and decision

The integration includes both Speaker Diarization and Dashboard/Export. A clean textual merge is **not** sufficient for shared S3 infrastructure: media source/worker operations and private Export artifacts have different immutability and authorization requirements.

### Protected key operations

| Operation | Media/processing key | Canonical `exports/<uuid>/...` key |
| --- | --- | --- |
| Generic presigned PUT/GET | Existing media access policy | **Rejected** (not a download authorization mechanism) |
| Generic accepted-source PUT | Existing conditional write path | **Rejected** |
| Generic download-to-file | Existing server-side media flow | **Rejected** |
| Generic unconditional delete | Existing media lifecycle, except immutable diarization results | **Rejected** |
| Bounded private GET | Maximum 16 MiB, preserve develop semantics | Canonical key required, maximum 32 MiB |
| Immutable export PUT | Not accepted | Canonical key, 1–32 MiB, exact MIME and SHA-256 verified before S3 PUT |
| Export presigned GET | Not accepted | Canonical artifact key, matching UUID/extension/filename, signed response headers, TTL 30–300 s |
| Conditional ETag delete | Not accepted | Canonical export key and validated ETag only; callers must independently prove orphan status |

**Authorization remains at the API boundary**: `ExportAccessService` checks current meeting access before and after object verification; it refuses non-HTTPS/unsigned capability URLs and audits issuance before returning them. The low-level storage adapter must never be treated as an HTTP access-control decision.

### Source and storage consistency

- The Diarization `processing/.../diarization/results/...` unconditional-delete guard stays intact.
- Export `snapshots/<source-fingerprint>.json` paths intentionally use the **source fingerprint** in the name; byte digest verification is independent of the key name. `intake` and `artifacts` have their own immutable server paths.
- ETag is only an atomic conditional-delete precondition, **not proof of whole-object byte integrity**. Export store independently compares SHA-256 of bounded GET bytes against its pinned DB digest.
- `ExportOrphanReconciler` still requires the durable two-pass quarantine, fresh LastModified/ETag evidence, DB claim lease, zero committed references, an approved D11 policy reference and an enabled purge flag. The storage adapter cannot grant these approvals.
- Invalid paths, MIME type, digest or public signing origin fail before S3 access. Invalid public endpoint configuration is rejected before S3 clients are allocated.

### Configuration contract

`APP_MEDIA_STORAGE_PUBLIC_DOWNLOAD_ENDPOINT` is an optional **HTTPS origin** used only for browser-facing Export signing. It must have no credentials, query, fragment or non-root path. It is deliberately separate from the S3 private API endpoint and never defaults to an untrusted public URL. When absent, signing uses the existing internal endpoint for SDK compatibility; `ExportAccessService` still rejects an HTTP capability at the API boundary.

All high-impact gates remain OFF by default and require independent operator approval:

- `APP_EXPORTS_PUBLIC_ADMISSION_ENABLED=false`
- `APP_EXPORTS_WORKER_ENABLED=false`
- `APP_EXPORTS_RECONCILIATION_ENABLED=false`
- `APP_EXPORTS_RECONCILIATION_PURGE_ENABLED=false`
- `APP_MEDIA_PROCESSING_DIARIZATION_ENABLED=false`
- `APP_WORKER_DIARIZATION_ENABLED=false`

The merged Maven graph preserves the existing Spring Boot/AWS SDK dependencies, Micrometer Prometheus private registry from `develop`, and PDFBox/DejaVu PDF rendering dependencies from the feature branch. Scrape endpoints remain denied publicly.

### Test and CI gate

- `ExportObjectKeyPolicyTests`: canonical/invalid paths, MIME/digest checks, read ceilings, key/filename binding, ETag constraints.
- `ExportS3StorageIntegrationTests`: actual RustFS private object persistence, verified signed GET, immutability, conditional deletion, and negative media-bypass operations.
- `WorkerResultStorageTests`: bounded streaming, unchanged 16 MiB Diarization limit, immutable result deletion guard.
- `StorageConfigurationContractTests`: explicit fail-closed defaults and independent Spring property binding.
- Existing Media/Diarization/Export integration tests remain active, including PostgreSQL/Flyway V43.

Task 02 closes only after full API CI, AI CI and Diarization Full-Stack CI are all green on the **same final commit**. No CI test is skipped or relaxed to manufacture a green run.

**Not Task 02**: final transcript-revision/export-freshness semantic integration (Task 03) and production/performance/human decision approval (Task 04).
