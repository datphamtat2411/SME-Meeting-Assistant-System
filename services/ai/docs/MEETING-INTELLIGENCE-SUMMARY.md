# AIMI-T04 Summary Processor

The Summary processor consumes the verified T02 `StageContext` through T03
`prepare_context()`. It never downloads a transcript, selects a revision, writes
Core-owned tables, or treats generated text as an authoritative decision.

## Processing Flow

1. Extract bounded Vietnamese information units from every complete T03 context
   window using a strict JSON schema. Units are categorized as discussion topics,
   facts, problems, conclusions, proposals, agreements, open questions,
   rejections, corrections, or disagreements.
2. Resolve every returned segment ID and Unicode half-open character range against
   the complete verified source. References outside the current window,
   mismatched source identity, unsupported numbers, fabricated speaker labels,
   prompt-injection text, and ungrounded paraphrases fail the stage.
3. Merge repeated units from overlapping windows by category and canonical source
   references. Source order, qualifications, uncertainty, and all supporting
   references remain attached to the unit.
4. For multiple windows, synthesize only validated derived evidence. If it does
   not fit the configured input budget, bounded reduction levels run with a
   finite depth and model-call budget. Raw transcript text is not resubmitted.
5. Render validated claims deterministically as Vietnamese Markdown. Sections are
   omitted when no supported content exists. Proposal, rejection, correction,
   disagreement, and agreement categories remain visibly distinct.

The final candidate is the existing T02 Summary shape:

```json
{
  "producer": {
    "model": "openai/gpt-5-mini",
    "promptVersion": "summary-v1",
    "provider": "openrouter"
  },
  "result": {"content": "...", "warnings": []}
}
```

`producer` values come from the executed adapter request. Content is rejected if
it exceeds 20,000 characters; it is never silently truncated. The mapping from
content to evidence is feature-local and is not persisted as a new canonical
field.

## Activation

Summary stays disabled unless all three settings are true:

- `AI_MEETING_INTELLIGENCE_WORKER_ENABLED=true`
- `AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED=true`
- `AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED=true`

The worker then creates one shared `OpenRouterIntelligenceAdapter` and registers
only `GENERATING_SUMMARY`. Decision and Action Item processors are not registered.
Provider, model, timeout, response-size, concurrency, and retry settings are
shared with T03. Summary-specific controls are:

- `AI_MEETING_INTELLIGENCE_SUMMARY_TARGET_CHARS` (default `8000`)
- `AI_MEETING_INTELLIGENCE_SUMMARY_MAX_RECORDS` (default `2048`)
- `AI_MEETING_INTELLIGENCE_SUMMARY_MAX_SYNTHESIS_DEPTH` (default `3`)
- `AI_MEETING_INTELLIGENCE_SUMMARY_MAX_MODEL_CALLS` (default `128`)

The original T02 deadline and cancellation fence apply to planning, every model
call, reduction, rendering, storage, and acceptance. The worker owns failure,
lease, result-storage, and acknowledgment behavior.

## Warnings and Boundaries

The canonical warning list uses only existing codes: `INCOMPLETE_COVERAGE`,
`UNRESOLVED_EVIDENCE`, `SUSPICIOUS_EVIDENCE`, and `SOURCE_QUALITY_WARNING`.
Unknown coverage is never interpreted as complete coverage. Unknown speakers and
timing remain internal qualifications or source notes; anonymous labels are not
converted to identities.

Summary is a secondary AI representation, not a replacement for the original
transcript and not confirmation of a proposed business decision. Human review
and Core-owned approval remain authoritative. Vietnamese semantic quality,
provider behavior, and model regressions require the broader AIMI-T07 evaluation;
the deterministic fixtures here establish contracts and safety boundaries only.

AIMI-T05 owns Decision Extraction and AIMI-T06 owns Action Item Extraction. This
feature does not create official decisions, tasks, assignments, or deadlines.
