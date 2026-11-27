# Wave 04 — Assistant reliability, evidence and client integration

Branch: pre-integration-develop. Verified entry HEAD:
`0a8332556819ba4a19a0d03f19d4d77ec8d623ab` (all eight Wave 03 workflows passed). Presentation reference:
web/integration-rush. No other branch rewritten.

## Delivery matrix

| Work package | Implementation / verification |
| --- | --- |
| W4-01 | [Shared integration contract](ASSISTANT-INTEGRATION-CONTRACT.md); existing package-level contracts remain owners. |
| W4-02 | Persisted active actor and content rights checked after admission locks and before inference; concurrent same-key creation and lock-wait revocation tests against PostgreSQL. |
| W4-03 | Preserve durable turn/lease fencing, explicit recovery, status/history semantics and existing replay/quota regression suites. |
| W4-04 | Exact authorized scope equality; expired/empty scope cannot contextualize protected dialogue; out-of-scope retrieval evidence rejected before generation. Existing model/index stack retained. |
| W4-05 | Canonical message evidence endpoint, selected citation proof, revision and access revalidation; existing Core/AI grounding tests plus Vietnamese deterministic negative cases. |
| W4-06 | Web creation sends key; unresolved exact intent retries reuse it; honor Retry-After, with browser regression. No layout redesign. |
| W4-07 | Mobile parses pendingTurn and nextBeforeMessageId, observes/reclaims durable ID without original key, revalidates anchored history; Java-compatible Unicode input. |
| W4-08 | Mobile canonical evidence check before/after artifact read, all four source types; malformed proof and revocation regression tests. Cross-client contract behavior verified by component suites, not live simultaneous devices. |
| W4-09 | Integration record, ledger and final same-SHA CI gate; final run status is obtained from GitHub Actions. |

## Observed historical verification

At `09e970b6e15b51576426dd41c00837ddfa976be8`, [Web](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953056872),
[Mobile](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953056868), [PI Integration](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953057003),
[PI-05](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953056918) and [PI-06](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953056965) passed.
API, AI and Diarization runs at that SHA were canceled by subsequent changes;
they are not counted as successful. At
`812613f708288a861978f29898e875645a2436b4`, Web, PI Integration, PI-05 and
PI-06 passed; Mobile formatting reported a line-wrap difference, corrected
using the formatter output. No failing assertion was removed or bypassed.
Do not attribute intermediate CI results to a later SHA.

## Observed final Wave 04 verification

All eight workflows passed on `bada2ee6ea4bb18f9c87c8ff2b63c5ec4dfa5bf4`:
[API](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990402),
[Web](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990398),
[Mobile](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990369),
[AI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990441),
[Diarization](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990521),
[PI Integration](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990379),
[PI-05](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990504),
[PI-06](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45953990473).
These are the Wave 05 entry baseline, not proof for a subsequent SHA.

## Final acceptance

All eight workflows must pass on the exact final candidate SHA: API, Web,
Mobile, AI, Diarization Full-Stack, PI Integration, PI-05 System Acceptance and
PI-06 Operational Readiness. See [branch Actions](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions?query=branch%3Apre-integration-develop).
The closing handoff records the final SHA and exact run links, rather than
creating a documentation-only commit after successful CI that changes the
verified SHA. This implementation record does not claim an unobserved green
final gate.

Live deployed cross-client conversation/evidence/recovery, live model and
Qdrant evaluation (including Vietnamese retrieval quality), visual comparison
and operational acceptance remain INT-14/15. Global Assistant and released v1
consumer inventory remain separate explicit decisions. No new API aliases,
migration, model changes, or workflow weakening.
