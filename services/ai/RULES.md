# AI Core Rules

Applies to `services/ai/`.

## Architecture & Ownership

- Keep AI Core as a modular Python/FastAPI service organized by capability. Do not split capabilities into independently deployed microservices.
- Separate HTTP handling from long-running AI processing. Run durable jobs in dedicated workers.
- Keep processing logic within its owning capability. Share only cross-cutting runtime concerns and integrations.
- Isolate model providers and infrastructure behind adapters. Use normalized internal contracts instead of vendor-specific payloads.
- Expose AI functionality to Web and Mobile only through the Core API.
- Core API owns business state, authorization, and user-visible jobs. AI Core must not directly modify canonical business data. Keep AI-owned processing state separate.

## Processing & Reliability

- Treat AI outputs as untrusted. Validate and normalize them before use; never automatically promote AI proposals into confirmed business records.
- Preserve source evidence, processing provenance, and completed stages. Downstream failures must not invalidate successful upstream results.
- Keep original media recoverable. Raw Whisper output is temporary processing evidence, not a durable transcript or debugging artifact.
- Use durable messaging for long-running jobs. Design consumers for at-least-once delivery, stable job identity, bounded retries, explicit acknowledgements, and terminal failure handling.
- Reference large media and artifacts by approved storage IDs, not message payloads.
- Enforce workload-appropriate limits on inference concurrency, execution time, and resource consumption.

## Models & AI Quality

- Keep model and provider identifiers configurable and traceable. Record relevant model, prompt, configuration, and source-version provenance.
- Evaluate compatibility and quality before changing model roles, providers, processing behavior, or retrieval strategies.
- Prefer grounded evidence, recoverability, and explicit uncertainty over unsupported claims. Human-authoritative corrections override conflicting AI output.
- Evaluate Vietnamese meeting capabilities using Vietnamese test data, not English-only benchmarks.
- Keep approved local audio datasets, annotations, model artifacts, and evaluation evidence outside the Git repository. Never copy private assets into Git or modify approved artifacts without task authorization.
- Only for tasks requiring these assets, agents may consult the [private workspace overview](README.md#local-private-evaluation-workspace) and inspect relevant local files. Do not assume the workspace exists or access it indiscriminately.

## Security & Data Boundaries

- Authenticate and authorize internal service communication. Network access alone does not establish trust.
- Enforce authorization before RAG retrieval, not solely through post-search filtering.
- Treat transcripts, retrieved content, user inputs, and model outputs as untrusted data, never privileged instructions.
- Minimize sensitive data sent to external providers. Never expose credentials, private meeting content, raw prompts, or provider internals in logs or errors.
- Isolate AI workers with least-privilege access to messaging, storage, models, and external services.

