# 05-internal-service-security.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Internal Service Security for `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing FastAPI application, routing, settings, and request lifecycle;
- current error handling, correlation logging, and focused HTTP tests;
- existing service identity or TLS integration points, if any.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/INTERFACES.md`;
- `services/ai/docs/TESTING.md`.

Follow task-related source dependencies only. Avoid broad repository discovery.

Plan these capabilities:
- establish a reusable, default-deny authentication and service-authorization boundary for future protected internal HTTP operations;
- validate approved Core API service identity and reject missing, invalid, or unauthorized identities;
- preserve unauthenticated `GET /health/live` and `GET /health/ready` probes;
- provide sanitized, consistent authentication/authorization failures and focused security tests.

Task-specific constraints:
- production direct Core API ↔ AI Core HTTP uses mTLS with service-specific certificates as the preferred baseline; both peers verify identities;
- certificate verification may occur at trusted TLS ingress, but application identity must derive solely from that verified boundary, never arbitrary client-supplied headers or private-network location;
- any proxy-to-application identity forwarding requires an explicitly protected, non-bypassable trust channel; do not treat unverified forwarded headers as authentication;
- fail closed when trusted identity integration or required production security configuration is unavailable;
- use distinct service identities and allow only explicitly approved callers/operations;
- user access/refresh tokens must not serve as workload credentials; Core API retains user authorization authority;
- reuse Task 02 settings and Task 03 safe logging; never disclose credentials, certificates, or internal security details;
- test protection using isolated test routes; do not add product endpoints.

Out of scope:
- certificate issuance, reverse-proxy/service-mesh deployment, and production TLS orchestration (Task 07);
- Assistant endpoints, RAG scope authorization, RabbitMQ authentication, and user session handling;
- custom token issuers, permanent API keys, and unrelated security infrastructure.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines.
Organize Proposed Changes by capability or concern, not by file.
Keep File Delta to Modify / Add / Remove inventory only.
Do not modify repository files.
