import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { parseMinutes } from './minutes-api'

const meetingId = '11111111-1111-4111-8111-111111111111'

function validMinutes() {
  return {
    schemaVersion: 1,
    assembledAt: '2026-11-25T08:00:00Z',
    sourceFingerprint: 'a'.repeat(64),
    completeness: 'COMPLETE',
    proposalsIncluded: false,
    warnings: [],
    meeting: {
      id: meetingId,
      title: 'Launch planning',
      description: null,
      organizerUserId: '22222222-2222-4222-8222-222222222222',
      status: 'ENDED',
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      endedAt: '2026-11-25T08:00:00Z',
    },
    summary: {
      availability: 'AVAILABLE',
      id: '33333333-3333-4333-8333-333333333333',
      versionNumber: 1,
      content: 'Reviewed summary',
      sourceType: 'AI_GENERATED',
      qualityStatus: 'READY',
      transcriptId: '44444444-4444-4444-8444-444444444444',
      contentRevision: 1,
      selectionEpoch: 1,
      isStale: false,
      aiWarnings: [],
    },
    confirmedDecisions: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        content: 'Ship the reviewed release.',
        status: 'CONFIRMED',
        sourceType: 'MANUAL',
        version: 1,
        confirmedByUserId: '22222222-2222-4222-8222-222222222222',
        confirmedAt: '2026-11-25T08:00:00Z',
        transcriptId: null,
        contentRevision: null,
        aiUncertainty: null,
        evidenceSegmentIds: [],
        isStale: false,
        aiWarnings: [],
      },
    ],
    officialActionItems: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Publish the release notes',
        details: null,
        status: 'OPEN',
        sourceType: 'MANUAL',
        assigneeUserId: '22222222-2222-4222-8222-222222222222',
        dueDate: null,
        version: 1,
        createdAt: '2026-11-25T08:00:00Z',
        confirmedByUserId: null,
        confirmedAt: null,
      },
    ],
    transcript: {
      availability: 'AVAILABLE',
      id: '44444444-4444-4444-8444-444444444444',
      processingJobId: null,
      versionNumber: 1,
      languageCode: 'en',
      status: 'READY',
      contentRevision: 1,
      durationMs: 1000,
      suspiciousSegments: 0,
      unresolvedSegments: 0,
      unresolvedCoverageRegions: 0,
    },
  }
}

describe('canonical Minutes adapter', () => {
  it('accepts a complete authoritative snapshot', () => {
    expect(parseMinutes(validMinutes()).meeting.id).toBe(meetingId)
  })

  it('rejects an unsupported schema version', () => {
    expect(() =>
      parseMinutes({ ...validMinutes(), schemaVersion: 2 })
    ).toThrowError(CoreApiError)
  })

  it('rejects a snapshot whose meeting identity does not match the request', () => {
    expect(() =>
      parseMinutes(validMinutes(), '66666666-6666-4666-8666-666666666666')
    ).toThrowError(/different meeting/i)
  })

  it('rejects missing trust-critical decision fields rather than defaulting them', () => {
    const valid = validMinutes()
    const decision = valid.confirmedDecisions[0]
    for (const field of [
      'isStale',
      'aiWarnings',
      'evidenceSegmentIds',
    ] as const) {
      expect(() =>
        parseMinutes({
          ...valid,
          confirmedDecisions: [{ ...decision, [field]: undefined }],
        })
      ).toThrow(CoreApiError)
    }
  })

  it('rejects malformed quality counters and preserves optional display enrichment', () => {
    const valid = validMinutes()
    expect(parseMinutes(valid).displayMetadata.assigneeDisplayNames).toEqual({})
    expect(() =>
      parseMinutes({
        ...valid,
        transcript: { ...valid.transcript, unresolvedSegments: -1 },
      })
    ).toThrow(CoreApiError)
  })

  it('rejects unknown closed source states and contradictory completeness', () => {
    const valid = validMinutes()
    for (const field of ['summary', 'transcript'] as const) {
      expect(() =>
        parseMinutes({
          ...valid,
          [field]: { ...valid[field], availability: 'FUTURE_BACKEND_STATE' },
        })
      ).toThrow(CoreApiError)
      expect(() =>
        parseMinutes({
          ...valid,
          [field]: { ...valid[field], availability: 'NOT_AVAILABLE' },
        })
      ).toThrow(CoreApiError)
    }
    expect(() =>
      parseMinutes({
        ...valid,
        summary: { ...valid.summary, sourceType: 'UNKNOWN' },
      })
    ).toThrow(CoreApiError)
    expect(() =>
      parseMinutes({
        ...valid,
        transcript: { ...valid.transcript, unresolvedSegments: 1 },
      })
    ).toThrow(CoreApiError)
  })

  it('accepts a genuinely partial snapshot and preserves review warnings', () => {
    const valid = validMinutes()
    const partial = {
      ...valid,
      completeness: 'PARTIAL',
      warnings: ['TRANSCRIPT_PROCESSING'],
      transcript: {
        ...valid.transcript,
        availability: 'PROCESSING',
        status: 'PROCESSING',
      },
    }
    expect(parseMinutes(partial).completeness).toBe('PARTIAL')
    expect(parseMinutes(partial).warnings).toEqual(['TRANSCRIPT_PROCESSING'])
  })

  it('rejects malformed fingerprints and unconfirmed work', () => {
    expect(() =>
      parseMinutes({
        ...validMinutes(),
        sourceFingerprint: 'not-a-fingerprint',
      })
    ).toThrowError(CoreApiError)

    expect(() =>
      parseMinutes({
        ...validMinutes(),
        officialActionItems: [
          {
            ...validMinutes().officialActionItems[0],
            sourceType: 'AI_EXTRACTED',
            status: 'PROPOSED',
            confirmedByUserId: null,
          },
        ],
      })
    ).toThrowError(/invalid canonical Minutes snapshot/i)
  })
})
