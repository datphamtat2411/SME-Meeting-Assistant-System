# RAG-T01 Knowledge Processing

The reusable boundary is `sme_meeting_ai.rag.process_snapshot()`:

```text
validated canonical snapshot
  -> trusted eligibility
  -> source-specific normalization
  -> injected-token-counter chunking
  -> provenance-enriched KnowledgeChunk values
```

The implementation does not load a model, contact Core API, publish events,
write a vector store, or persist canonical state.

## Core Compatibility

`TranscriptSnapshot.payload` is the existing immutable Core projection:
`schemaVersion`, `transcript`, `coverage`, and `speakers`. The transcript
projection fields and quality values match `TranscriptViews` and
`TranscriptSnapshotCapture`. T01 wraps that payload with a required immutable
snapshot ID, source identity/revision, optional integrity descriptor, and
trusted `current`/`RECONCILED` state. The wrapper prevents a raw ASR payload
from being treated as the current transcript and keeps snapshot identity
separate from transcript identity.

Summary, decision, and action-item snapshots intentionally use separate
projections. Core adapters must map:

- the current approved summary selection to `isCurrent=true`, `isApproved=true`,
  and `isStale=false`; its existing `contentRevision` maps to the optional
  transcript lineage revision;
- the canonical decision status and stale calculation to `status` and
  `isStale`; the existing `transcriptId`/`contentRevision` pair maps to
  evidence lineage;
- the existing official action-item read rule (`status != PROPOSED` and manual
  or human-confirmed origin) to `isOfficial=true`; its existing
  `transcriptId`/`contentRevision` values are accepted when supplied by a
  richer projection.

The current action-item read view does not expose transcript evidence lineage;
those fields remain optional in T01 and should be populated by a future Core
projection when available. T01 does not add a migration or change Core
business rules.

## Versioning

`SourceRevision` identifies the canonical business artifact. `IndexGeneration`
identifies the chunking/token-counter representation. `KnowledgeChunk.chunkId`
is a deterministic UUID derived from both, the stable source references,
position, and retrieval text. No execution timestamp or random UUID enters the
identity.

## Integration Dependencies

Future Core/AI integration must provide a versioned snapshot exchange carrying
the wrapper metadata above, a Core-approved finite meeting scope, and the
logical `IndexLifecycleEvent` contract. An empty authorized meeting scope is
always no retrieval. Event payloads carry immutable snapshot references rather
than transcript content. Transport, authorization, event publication, and
index persistence are later-task responsibilities.

`RetrievalScopeRequest` keeps that Core-approved scope separate from
user-controlled narrowing filters; the latter can only reduce the effective
meeting set.

T02 must bind the injected `TokenCounter` to the approved BGE-M3 tokenizer and
create a new `IndexGeneration`; T01 intentionally makes no BGE-M3 tokenization
claim.
