# Wave 03 — Transcript and Meeting Intelligence integration record

Branch: `pre-integration-develop`. Verified entry code: `1715c7c471a4c6c19b7dca4884bc4ac0fdf1f17d`; documentation entry HEAD: `7bd02a70fe866b7dfdebcdf31bc56cb9731a94c3`. Presentation reference: `web/integration-rush`.

## Delivery and acceptance matrix

| Work package | Delivered / verification boundary |
| --- | --- |
| W3-01 | Canonical [Transcript/Decision contract](TRANSCRIPT-DECISION-CONTRACT.md); Wave 02 evidence already closed at entry. |
| W3-02 | Preserve source guards and revision semantics; revalidate persisted active account and organizer/meeting status after acquiring review/admission locks and before idempotent replay. Added real PostgreSQL lock-wait regression and stale receipt/new proof scenario. Full Core CI pending. |
| W3-03 | Web consumes server-issued opaque segment tokens, binds draft to original token, fails closed on missing tokens, retains draft on conflict. No timeline redesign. |
| W3-04 | Mobile canonical UTF-8 digest, exact job/media/transcript identity, receipt validation, distinct deterministic acknowledgement/admission keys, application-owned session-fenced operation state, explicit exact-intent recovery. No persistent transcript content or credentials added. |
| W3-05 | Recording and Processing open existing Results transcript review for exact job; separate acknowledgement and admission; verified coverage and warnings; block unresolved drafts/operations; return to processing after accepted admission. |
| W3-06 | Web manual Decision evidence creation carries reviewed transcript ID and revision; no tuple for evidence-free creation; retain draft and require review after stale source. |
| W3-07 | Web proposal confirmation uses snapshot-bound coverage and accepted segment quality; stale/unsafe evidence cannot be confirmed; authorized rejection retained. Existing Results invalidation and summary provenance retained. |
| W3-08 | Added adapter, browser, Flutter manager/repository/widget and PostgreSQL/MockMvc regression scenarios, including shared digest golden values and stale receipt rejection. Automated gate still pending. These are not simultaneous live Web/Mobile clients on a deployed backend. |
| W3-09 | Implementation record and historical evidence here; final acceptance requires all eight workflows passing on one exact HEAD. |

## Observed evidence (not attributed to later commits)

- At `d0ff8d5b6478e7de2372090d642500de8a084d89`, Web Chromium browser [job](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946242940/job/140331575664): 149 files, 1,270 tests passed, including all eight intelligence review integration tests. Static formatting was still pending.
- At `4928c681f08e3e58ce36cb2eb24765de31ec72ee`, [Web CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946588342), [PI Integration](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946588392), [PI-05](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946588294) and [PI-06](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946588299) passed. [Mobile CI](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/45946588427) passed format/analyze; 704 tests passed and one failed. All four new lower-level admission tests passed. The new actual-widget flow's tap was outside the viewport, before dispatch; the correction scrolls to the control, pumps layout and asserts hit-testability before the gesture. The original business assertions are retained. Subsequent full Mobile verification is required.
- Earlier formatter/analyzer errors were fixed using actual CI output, not disabling checks. Earlier canceled runs are not evidence of success.

## Final verification gate

All eight workflows must be successful at the same final SHA: API, Web, Mobile, AI, Diarization Full-Stack, PI Integration, PI-05 System Acceptance, PI-06 Operational Readiness. Inspect [branch Actions](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions?query=branch%3Apre-integration-develop) and record exact run IDs and SHA in the closing evidence. No final green gate is claimed by this pre-verification record.

The five existing path-filtered integration workflows now also trigger for Web/Mobile and integration documentation changes, so client-only or evidence-only commits can be verified without weakening any workflow job or assertion.

## Boundaries and remaining acceptance

No API endpoint aliases, database migrations, AI-model changes or presentation redesign. Review admission recovery state is owned by the app-scoped ProcessingManager and scoped to the authenticated session/job; a fully terminated app does not retain a pending operation object. Stable proof-bound keys enable safe same-proof retries, but live process-death recovery and device lifecycle checks remain explicit acceptance work. Full live ASR/LLM, deployed simultaneous Web/Mobile, visual comparison, and operational acceptance remain INT-14/15; do not represent deterministic fixtures as live proof.
