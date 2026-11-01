# MI-PM-05 — AI Quality Signals and Producer Provenance

**Scope:** API-side acceptance and read models only. No modification to AI Core models, inference, prompt templates or worker protocol. Uses the existing strict v1 payload and canonical receipt/summary/decision ownership.

## Design choices

- **Immutable receipt as producer attribution:** V25 adds `producer_model`, `producer_prompt_version`, optional `producer_provider`, and `result_warning_codes` to `meeting_intelligence_result_receipts`. All are bounded, validated, and inserted atomically with result acceptance. Historic receipts remain nullable for producer attribution so an existing database upgrades safely. Receipt mutation remains forbidden by V23.
- **Per-Summary-version quality:** V25 adds bounded `ai_warning_codes` to `meeting_summary_versions`. Validated AI warnings influence `quality_status` alongside the *independent* Transcript-derived warning flag: either may produce `READY_WITH_WARNINGS`. The warning codes are preserved as advisory AI provenance; they do **not** override Transcript quality or authorize official status. A human edit inherits the source version's warning codes but retains `source_type=HUMAN_EDIT`, its own actor and revision lineage. A non-current AI candidate retains its own model attribution through its receipt. A human revision is not falsely attributed to an AI producer.
- **Decision uncertainty:** V25 adds nullable `ai_uncertainty` to AI-extracted Decisions (NONE/LOW/MATERIAL); manual Decisions retain null. This AI claim is immutable and advisory; `PROPOSED` Decisions still require explicit human confirmation with the existing reviewability check. The full batch warning list and producer attribution are read from the accepted receipt.
- **Typed projections:** Auth-scoped Summary, Summary version history and Decision responses expose optional `aiProducer` and bounded `aiWarnings`. Decision includes optional `aiUncertainty`. The producer is validated **untrusted provenance**, not an authenticated workload identity or decision authority; neither secrets nor raw model prompts are stored.
- **No generic JSON metadata framework:** small typed columns and fixed enum warning arrays are safer to query, enforce, evolve and test. Do not change any existing Flyway V1–V24 checksums. V25 adds independent DB checks and immutable metadata triggers for historical Summary warning codes and Decision uncertainty.

## Security and compatibility

- Meeting-owned authorization remains the only way to reach the read projections. SQL joins scope receipt attributes to the same meeting. No arbitrary provider payload is written into audit or metric labels.
- Existing manual/historical data remains readable: old receipt attribution null, old warning arrays empty, old AI Decision uncertainty null. HTTP fields are additive; no existing JSON fields or ETag formats are removed.
- The external v1 envelope keys are unchanged; the API now **preserves** fields already required by the v1 contract rather than asking AI Core to change model outputs.
- Extraction batch with zero candidates still persists its warnings and receipt but creates no fake Decisions.

## Verification

`IntelligenceResultIngestionIntegrationTests`: producer/warnings on Summary public/private HTTP projections, replay, human version copy, decision MATERIAL uncertainty through human confirmation, zero-decision warning receipt, and immutable metadata DB constraints. Existing strict result validation, transcript source fencing, rollback and full API CI remain required.

The production AI worker adapter and negotiated transport remain G2/MI-PM-07 and are not represented as complete by this API-only improvement. **Final HEAD must have GitHub Actions API CI success.**
