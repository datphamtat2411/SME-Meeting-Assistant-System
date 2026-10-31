# MI-01 AI Result Contract — Examples and Consumer Rules

> **Status:** draft for API + AI review; these fixtures are schema-level examples, not runnable processing jobs.
> **Schema:** meeting-intelligence-result-v1.schema.json.

## Digest and identity semantics (proposed)

- The resultSha256 field is lowercase SHA-256 of the UTF-8 RFC 8785 (JCS) canonicalization of the **result** object. The example digests below are computed for the displayed results.
- source.sha256 is SHA-256 of the exact immutable, authorized source snapshot bytes referenced by inputSnapshotId. In the examples it is an artificial placeholder, not a valid recorded source; stage claims and authoritative source records must be resolved from database state.
- The entire externally stored result artifact must also have an independently verified object digest at the trusted storage boundary before parsing. This object digest is distinct from resultSha256.
- processingJobId, stageRunId, transcriptId, contentRevision, inputSnapshotId and candidateKey in JSON are untrusted claims to cross-check against the job, stage lease and pinned source. The authenticated worker adapter retains the claimToken out-of-band; it is never model-generated.
- producer.model/promptVersion are provenance metadata, never authority. Source snapshot must be selected by Core API; AI outputs cannot switch sources.
- JSON Schema format: uuid requires a validator configured to **assert** formats; treat it as a real validation requirement, not a decorative annotation.
- Validate max payload size, business rules, text normalization, source membership, duplicate candidateKey, source digest, live stage lease, and model-produced warning consistency outside JSON Schema. Limit list cardinality and stored text by approved limits at ingress.
- Zero candidates is valid for DECISION_EXTRACTION and must still produce an accepted ingestion receipt. A missing evidence reference is not silently fabricated. No manual confirm/actor/status/isCurrent properties are admitted by the schema.

## Valid structural fixture A — Summary

    {
      "schemaVersion": "1.0",
      "processingJobId": "11111111-1111-4111-8111-111111111111",
      "stageRunId": "22222222-2222-4222-8222-222222222222",
      "source": {
        "transcriptId": "33333333-3333-4333-8333-333333333333",
        "contentRevision": 4,
        "inputSnapshotId": "44444444-4444-4444-8444-444444444444",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "producer": {
        "model": "example-model",
        "promptVersion": "meeting-intelligence-v1"
      },
      "resultType": "SUMMARY",
      "resultSha256": "b5bcb17d605b65ec76032547ef92a30e1dfad65e039d5c2558c9468b40fe4ad9",
      "result": {
        "content": "The team agreed to start a pilot in December.",
        "warnings": []
      }
    }

## Valid structural fixture B — Decision extraction

    {
      "schemaVersion": "1.0",
      "processingJobId": "11111111-1111-4111-8111-111111111111",
      "stageRunId": "22222222-2222-4222-8222-222222222222",
      "source": {
        "transcriptId": "33333333-3333-4333-8333-333333333333",
        "contentRevision": 4,
        "inputSnapshotId": "44444444-4444-4444-8444-444444444444",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "producer": {
        "model": "example-model",
        "promptVersion": "meeting-intelligence-v1"
      },
      "resultType": "DECISION_EXTRACTION",
      "resultSha256": "7665cc479591a86abc757ad3fcdc84072cbc04ef5f6094ad7f22501baa48dfa1",
      "result": {
        "candidates": [
          {
            "candidateKey": "d-1",
            "content": "Start the pilot in December.",
            "evidenceSegmentIds": [
              "55555555-5555-4555-8555-555555555555"
            ],
            "uncertainty": "NONE"
          }
        ],
        "warnings": []
      }
    }

## Invalid-contract/negative test vectors

| Case | Expected |
| --- | --- |
| AI adds confirmedByUserId, status or isCurrent | Reject unexpected property |
| schemaVersion differs from 1.0 | Reject unsupported version |
| resultType=SUMMARY with candidates payload | Reject subtype mismatch |
| resultType=DECISION_EXTRACTION without candidates | Reject |
| candidateKey repeated in the same batch | Reject in semantic validation |
| evidenceSegmentIds contains foreign transcript segment | Reject against DB |
| source.contentRevision does not match pinned job snapshot | Reject authoritative mismatch |
| resultSha256 differs from computed normalized result digest | Reject payload integrity mismatch |
| stage claim expired, superseded or wrong stage | Reject new acceptance |
| same stageRunId and resultType arrives with different digest | Conflict, no overwrite |
| valid empty decision candidates | Accept receipt with zero decision rows |
| source has unresolved regions but worker supplies warnings=[] | Derive quality from canonical source; do not rely solely on worker signal |

## Cross-team review before adoption

The API and AI owners must approve the schema fields, digest canonicalization, exact storage/result-reference transport, warning and uncertainty enums, payload size limits, source snapshot construction and stage ACK/NACK/retry classification. The contract is **not yet approved**; evolve as an explicitly versioned contract change and update MI01_ARCHITECTURE_AND_CONTRACTS.md gates G2/G4.
