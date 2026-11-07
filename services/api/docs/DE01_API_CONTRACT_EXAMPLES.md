# DE-01 — Candidate HTTP DTO Examples (NOT YET FROZEN)

> **Status:** Illustration for API/Product/Security review, not an implemented OpenAPI schema or approved DTO. All examples are mock data. RE02 remains authoritative for URLs, HTTP status and Common API Response. If examples conflict with canonical requirements, requirements prevail.
>
> **Companions:** DE01_DASHBOARD_EXPORT_CONTRACTS.md, DE01_METRIC_DICTIONARY.md, DE01_DECISION_REGISTER.md.

## Common rules for all six endpoints

- All successful normal JSON responses have success=true, code, message, data, meta.requestId and meta.timestamp. All errors have success=false, stable machine code, data=null and request correlation.
- Authentication comes from current Core API session, NOT arbitrary client userId, organization role, meeting owner or URL history.
- Sensitive personalized data and short-lived capability responses use Cache-Control: no-store.
- Proposed property names can be refined by Product/API reviewers; no endpoint method/path may be silently renamed.
- UUIDs below and the HTTPS URL are illustrative; never log real download URLs. Response objects must not include private S3 object keys.
- An asOf instant denotes when the current reporting projection was observed. It does not claim a historical as-of event-sourced query.
- If a metric is awaiting approved semantics, do not silently fill it with 0; omit it or return explicit unavailable metadata according to the approved DTO.

## 1. Personal Dashboard — API-EP-DASH-001

GET /api/v1/dashboard/me

Candidate 200 response:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {
    "asOf": "2026-11-07T12:00:00Z",
    "timezone": "Asia/Ho_Chi_Minh",
    "upcomingMeetings": [
      {
        "meetingId": "11111111-1111-4111-8111-111111111111",
        "title": "Sprint planning",
        "startsAt": "2026-11-09T02:00:00Z",
        "status": "SCHEDULED"
      }
    ],
    "recentMeetings": [],
    "assignedActionItems": {
      "open": 3,
      "inProgress": 2,
      "done": 4,
      "overdue": 1
    },
    "processingAttention": {
      "pendingReview": 1,
      "failedOrWarning": 0
    }
  },
  "meta": {
    "requestId": "11111111-1111-4111-8111-111111111112",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

Candidate future query: horizonDays (bounded). The approved default and maximum are pending D07; processingAttention needs D06. Upcoming/recent rows must be meeting-authorized; item metrics must be Action Items-authorized. The example is **not** proof those fields currently exist.

## 2. Management Dashboard — API-EP-DASH-002

GET /api/v1/dashboard/management?from=2026-11-01T00%3A00%3A00Z&to=2026-12-01T00%3A00%3A00Z

Candidate 200 response:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {
    "asOf": "2026-11-07T12:00:00Z",
    "period": {
      "from": "2026-11-01T00:00:00Z",
      "to": "2026-12-01T00:00:00Z",
      "endExclusive": true
    },
    "scope": {
      "organizationalUnitIds": ["22222222-2222-4222-8222-222222222222"]
    },
    "meetingCountsByState": {
      "draft": 0,
      "scheduled": 5,
      "inProgress": 1,
      "ended": 8,
      "cancelled": 1
    },
    "actionCountsByState": {
      "open": 8,
      "inProgress": 3,
      "done": 9,
      "cancelled": 1
    },
    "overdueActionItems": 4,
    "completionRate": {
      "numerator": 9,
      "denominator": 20,
      "valuePercent": 45.0
    },
    "aiProcessing": {
      "failedMeetings": 1,
      "warningMeetings": 2
    }
  },
  "meta": {
    "requestId": "22222222-2222-4222-8222-222222222223",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

**Review warning:** Example assumes explicitly approved period axis, management organizational attribution, rate formula and aggregate disclosure policy (D01–D06). Until those are approved, it cannot be used as an authoritative integration contract. JSON object property case/style also remains candidate; API enum codes (where enums are used) remain uppercase snake-case.

If denominator = 0, proposed completionRate.valuePercent = null, with numerator=0 and denominator=0. Do not label a current-state cohort as historical month-end state without an actual historical projection.

## 3. Consolidated Minutes — API-EP-EXP-001

GET /api/v1/meetings/11111111-1111-4111-8111-111111111111/minutes

Candidate 200 response (human-confirmed material and quality flags):

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {
    "meeting": {
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "Sprint planning",
      "status": "ENDED",
      "scheduledStartAt": "2026-11-06T02:00:00Z",
      "scheduledEndAt": "2026-11-06T03:00:00Z"
    },
    "asOf": "2026-11-07T12:00:00Z",
    "completeness": "PARTIAL",
    "summary": {
      "availability": "AVAILABLE",
      "sourceVersion": 2,
      "sourceType": "HUMAN_EDIT",
      "content": "Thảo luận kế hoạch sprint và thống nhất các đầu việc."
    },
    "decisions": {
      "confirmed": [
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "text": "Chốt phạm vi sprint tiếp theo."
        }
      ],
      "proposed": []
    },
    "actionItems": {
      "official": [
        {
          "id": "44444444-4444-4444-8444-444444444444",
          "title": "Hoàn thiện tài liệu API",
          "status": "OPEN",
          "dueDate": "2026-11-10"
        }
      ],
      "proposed": []
    },
    "transcript": {
      "availability": "NEEDS_REVIEW",
      "coverageWarnings": ["Transcript contains unresolved speech intervals."]
    },
    "warnings": ["Summary is available but transcript review remains incomplete."],
    "source": {
      "transcriptRevision": 4,
      "summaryVersion": 2,
      "sourceFingerprint": "example-not-a-real-sha256"
    }
  },
  "meta": {
    "requestId": "33333333-3333-4333-8333-333333333334",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

Completeness/availability codes, optional proposal inclusion and content fields are explicitly proposed pending D08. No inferred confirmation. For Summary and Decision JSON shapes, verify existing domain DTOs before finalizing to avoid incompatibility with current versions and attribution.

## 4. Export admission — API-EP-EXP-002

POST /api/v1/meetings/11111111-1111-4111-8111-111111111111/exports

Candidate headers: Content-Type: application/json; Idempotency-Key: client-generated-opaque-value

```json
{
  "format": "PDF"
}
```

Candidate 202 Accepted:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Export request accepted.",
  "data": {
    "exportId": "55555555-5555-4555-8555-555555555555",
    "meetingId": "11111111-1111-4111-8111-111111111111",
    "format": "PDF",
    "status": "PENDING",
    "createdAt": "2026-11-07T12:00:00Z"
  },
  "meta": {
    "requestId": "55555555-5555-4555-8555-555555555556",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

An idempotent replay (same actor/operation/intent) should point to the original export after current permission verification; exact replay HTTP status and TTL window require D10. Different request with the same key must conflict under API-IDEM-003. Do not implement arbitrary format or user-controlled object key.

## 5. Export status/metadata — API-EP-EXP-003

GET /api/v1/exports/55555555-5555-4555-8555-555555555555

Candidate 200 response after storage verification:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Request completed successfully.",
  "data": {
    "id": "55555555-5555-4555-8555-555555555555",
    "meetingId": "11111111-1111-4111-8111-111111111111",
    "format": "PDF",
    "status": "READY",
    "createdAt": "2026-11-07T12:00:00Z",
    "readyAt": "2026-11-07T12:00:20Z",
    "lastErrorCode": null,
    "freshness": {
      "isCurrent": true,
      "sourceFingerprint": "example-not-a-real-sha256"
    },
    "file": {
      "sizeBytes": 87234
    }
  },
  "meta": {
    "requestId": "55555555-5555-4555-8555-555555555557",
    "timestamp": "2026-11-07T12:00:22Z"
  }
}
```

Read metadata must never implicitly mint a download capability or expose object_key. Status and freshness represent different facts. Same export can remain READY but freshness.isCurrent=false after canonical revisions.

## 6. Signed access — API-EP-EXP-004

POST /api/v1/exports/55555555-5555-4555-8555-555555555555/access-url

Candidate 200 response (illustrative URL only):

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "Download capability created.",
  "data": {
    "url": "https://objects.example.invalid/download/opaque-capability",
    "expiresAt": "2026-11-07T12:01:00Z",
    "filename": "meeting-minutes.pdf",
    "contentType": "application/pdf"
  },
  "meta": {
    "requestId": "55555555-5555-4555-8555-555555555558",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

SEC-OBJ-004: signed download lifetime no more than 5 minutes. Proposed operational default 60 seconds (Security to approve). Already-issued capabilities may remain valid until expiry even after permission revoke; new capability issuance must fail.

## 7. Negative-path examples

Candidate 409 idempotency mismatch (same key, different body) uses global error envelope:

```json
{
  "success": false,
  "code": "RESOURCE_CONFLICT",
  "message": "Request conflicts with an existing export request.",
  "data": null,
  "meta": {
    "requestId": "66666666-6666-4666-8666-666666666666",
    "timestamp": "2026-11-07T12:00:00Z"
  }
}
```

RESOURCE_CONFLICT is an illustrative RE02 error-family member, not an assertion that this exact code is already implemented. Unauthorized meeting/export access uses current content authorization and may intentionally conceal existence via 404 rather than reveal 403. A not-yet-READY export has no download capability; whether access-url returns 409 or a more specific error must be documented before DE-10.

## 8. Contract approval and downstream verification

The OpenAPI component names, DTO property names, error-code registry, default query parameters, list caps, handling of incomplete Minutes and export replay semantics must be approved before runtime implementation. When finalized:
1. Add controller/OpenAPI implementation under the same six endpoints, not aliases.
2. Provide schema / serialization tests for all examples and for null/empty/error cases.
3. Test current authorization and session revocation through Spring HTTP boundary.
4. Update this examples document and companion decision register whenever approved design differs.
5. Preserve RE02 response envelope and source-of-truth semantics throughout.
