# 01-python-package-foundation.md

Read `AGENTS.md` and `services/ai/RULES.md`.

Plan Python Package Foundation for the current `module-core-runtime` in `services/ai/`.

Start discovery around:
- existing `pyproject.toml`, `uv.lock`, `.python-version`, and dependency/build configuration;
- current Python package structure, import behavior, and Git ignore conventions;
- repository CI patterns and existing AI testing/linting setup.

Read only:
- `services/ai/docs/ARCHITECTURE.md`;
- `services/ai/docs/TESTING.md`.

Follow task-related source dependencies as needed. Do not perform broad repository discovery.

Plan these capabilities:
- establish an installable Python package using `src/sme_meeting_ai/`;
- configure standards-compliant package building with `uv_build`;
- preserve reproducible dependency management through `uv` and `uv.lock`;
- establish focused pytest and Ruff verification;
- introduce lightweight AI-specific CI for package, lint, and test verification;
- exclude virtual environments, caches, and generated build artifacts from version control.

Task-specific constraints:
- preserve distribution name `sme-meeting-ai` and import name `sme_meeting_ai`;
- retain Python 3.12 as the development baseline and `requires-python >=3.12`;
- use `uv` exclusively for project dependency management;
- package installation must support imports without manual `PYTHONPATH` or `sys.path` modifications;
- `uv sync --locked` and `uv build` must succeed, producing valid wheel and source distributions;
- CI must remain scoped to AI service verification without running unrelated monorepo checks;
- preserve existing dependencies unless a task-related change is justified;
- introduce only necessary package structure, dependencies, and meaningful tests.

Out of scope:
- FastAPI application, HTTP routes, and runtime entrypoints;
- worker bootstrap, job processing, and RabbitMQ integration;
- runtime configuration, logging, authentication, and health endpoints;
- AI providers, audio processing, transcription, and RAG;
- Docker images and deployment orchestration.

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
