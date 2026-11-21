import { AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi, coreApiAxios, resetCsrfToken } from '@/lib/core-api'
import { resetRequestRecoveryState } from '@/lib/request-recovery'
import {
  OPERATOR_MI_SUMMARY_CONTRACT,
  actionItemEtag,
  admitOperatorProcessingJob,
  admitProcessingJob,
  applyApprovedTranscriptCorrection,
  confirmActionItem,
  confirmDecision,
  createSyntheticMeeting,
  fetchFinalizedTranscriptEvidence,
  fetchMeetingTranscript,
  fetchProcessingJob,
  isSameOriginCoreApi,
  readMeetingIntelligenceResults,
  rejectActionItem,
  rejectDecision,
  transcriptSegmentEtag,
  uploadAndFinalizeMeetingMedia,
  verifyOperatorSession,
} from './operator-mi-e2e-workflow'

function envelope<T>(data: T, meta: Record<string, unknown> = {}) {
  return {
    success: true,
    code: 'SUCCESS',
    message: 'Request completed successfully.',
    data,
    meta,
  }
}

function response(
  config: Parameters<AxiosAdapter>[0],
  data: unknown,
  status = 200,
  etag?: string
): AxiosResponse<unknown> {
  return {
    data,
    status,
    statusText: 'OK',
    headers: new AxiosHeaders(etag ? { ETag: etag } : {}),
    config,
  }
}

const identity = {
  userId: '46a30219-3c9f-498d-94fa-d6558f200714',
  email: 'e2e-04@example.invalid',
  displayName: 'E2E-04 Local Test',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '56b7d0a2-46c2-4f9b-bf2e-2e6f4f2d8f31',
    clientType: 'WEB' as const,
    createdAt: '2026-11-21T00:00:00Z',
    lastSeenAt: '2026-11-21T00:00:00Z',
    absoluteExpiresAt: '2026-11-22T00:00:00Z',
  },
}

const meeting = {
  id: 'meeting/1',
  title: 'Cuộc họp MI tiếng Việt',
  description: 'Synthetic bounded Vietnamese MI meeting.',
  organizerUserId: identity.userId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: identity.userId,
  createdAt: '2026-11-21T00:00:00Z',
  updatedAt: '2026-11-21T00:00:00Z',
}

const media = {
  id: 'media-1',
  meetingId: 'meeting/1',
  sourceType: 'UPLOAD',
  status: 'AVAILABLE',
  originalFilename: 'meeting.wav',
  contentType: 'audio/wav',
  sizeBytes: 3,
  durationMs: 3000,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-21T00:00:00Z',
  availableAt: '2026-11-21T00:01:00Z',
  failureCode: null,
}

const job = {
  id: 'job-1',
  meetingId: 'meeting/1',
  sourceMediaId: 'media-1',
  jobType: 'OFFLINE_MEETING_PROCESSING',
  status: 'PENDING',
  requestedByUserId: identity.userId,
  currentStage: null,
  queuedAt: '2026-11-21T00:02:00Z',
  startedAt: null,
  completedAt: null,
  errorCode: null,
  errorSummary: null,
  warningSummary: null,
  createdAt: '2026-11-21T00:02:00Z',
  updatedAt: '2026-11-21T00:02:00Z',
  reprocessOfJobId: null,
  retryable: false,
  retryCount: 0,
  stageRuns: [],
}

const transcript = {
  id: 'transcript-1',
  meetingId: 'meeting/1',
  sourceMediaId: 'media-1',
  processingJobId: 'job-1',
  versionNumber: 1,
  languageCode: 'vi',
  status: 'READY',
  durationMs: 3000,
  finalizedAt: '2026-11-21T00:03:00Z',
  contentRevision: 0,
  segments: [
    {
      id: 'segment-1',
      ordinal: 0,
      startMs: 0,
      endMs: 3000,
      text: 'Xin chào',
      qualityStatus: 'OK',
      speakerClusterId: null,
      speakerLabel: 'Speaker 1',
      version: 0,
    },
  ],
}

const summary = {
  id: 'summary-1',
  meetingId: 'meeting/1',
  versionNumber: 1,
  content: 'Tóm tắt cuộc họp.',
  sourceType: 'AI_GENERATED',
  qualityStatus: 'READY',
  processingJobId: 'job-1',
  transcriptId: 'transcript-1',
  contentRevision: 0,
  isStale: false,
  createdAt: '2026-11-21T00:04:00Z',
  createdByUserId: null,
  aiWarnings: [],
  aiProducer: {
    provider: 'test-provider',
    model: 'test-model',
    promptVersion: 'summary-v1',
  },
}

const decision = {
  id: 'decision-1',
  meetingId: 'meeting/1',
  content: 'Thông qua phương án A.',
  status: 'PROPOSED',
  sourceType: 'AI_EXTRACTED',
  evidenceSegmentIds: ['segment-1'],
  transcriptId: 'transcript-1',
  contentRevision: 0,
  isStale: false,
  version: 3,
  createdAt: '2026-11-21T00:04:00Z',
  createdByUserId: null,
  confirmedAt: null,
  confirmedByUserId: null,
  rejectedAt: null,
  rejectedByUserId: null,
  aiUncertainty: 'NONE',
  aiWarnings: [],
  aiProducer: {
    provider: 'test-provider',
    model: 'test-model',
    promptVersion: 'decision-v1',
  },
}

const actionItem = {
  id: 'action-1',
  meetingId: 'meeting/1',
  title: 'Chuẩn bị đề xuất',
  details: null,
  status: 'PROPOSED' as const,
  assigneeUserId: identity.userId,
  dueDate: null,
  overdue: false,
  sourceType: 'AI_EXTRACTED',
  processingJobId: 'job-1',
  createdByUserId: null,
  confirmedByUserId: null,
  confirmedAt: null,
  completedByUserId: null,
  completedAt: null,
  cancelledByUserId: null,
  cancelledAt: null,
  version: 2,
  createdAt: '2026-11-21T00:04:00Z',
  updatedAt: '2026-11-21T00:04:00Z',
}

describe('operator MI E2E workflow adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetCsrfToken()
    resetRequestRecoveryState()
    coreApiAxios.defaults.adapter = undefined
  })

  it('bootstraps CSRF and verifies the normal Web identity without returning CSRF data', async () => {
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/auth/csrf') {
        return response(config, envelope({ csrfToken: 'csrf-only-in-memory' }))
      }
      return response(config, envelope(identity))
    }

    await expect(verifyOperatorSession(identity.userId)).resolves.toEqual({
      user: identity,
    })

    expect(requests.map((request) => request.url)).toEqual([
      '/auth/csrf',
      '/auth/me',
    ])
    expect(requests[0]?.headers.get('X-CSRF-Token')).toBeUndefined()
    expect(requests[1]?.headers.get('X-CSRF-Token')).toBeUndefined()
    expect(
      JSON.stringify(await verifyOperatorSession(identity.userId))
    ).not.toContain('csrf-only-in-memory')
  })

  it('creates one synthetic meeting only after identity verification and confirms organizer ownership', async () => {
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/auth/csrf') {
        return response(config, envelope({ csrfToken: 'csrf-for-create' }))
      }
      if (config.url === '/auth/me') return response(config, envelope(identity))
      if (config.url === '/meetings' && config.method === 'post') {
        return response(config, envelope(meeting), 201, '"meeting-create-etag"')
      }
      if (config.url === '/meetings/meeting%2F1') {
        return response(config, envelope(meeting), 200, '"meeting-detail-etag"')
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`)
    }

    await expect(
      createSyntheticMeeting(
        {
          title: ' Cuộc họp MI tiếng Việt ',
          description: ' Synthetic bounded Vietnamese MI meeting. ',
        },
        'meeting-create-1',
        identity.userId
      )
    ).resolves.toMatchObject({
      meeting: { meeting, etag: '"meeting-create-etag"' },
      detail: { meeting, etag: '"meeting-detail-etag"' },
      organizerVerified: true,
    })

    expect(requests.map((request) => request.url)).toEqual([
      '/auth/csrf',
      '/auth/me',
      '/meetings',
      '/meetings/meeting%2F1',
    ])
    const createRequest = requests[2]
    expect(createRequest?.withCredentials).toBe(true)
    expect(createRequest?.headers.get('Idempotency-Key')).toBe(
      'meeting-create-1'
    )
    expect(createRequest?.headers.get('X-CSRF-Token')).toBe('csrf-for-create')
    expect(createRequest?.headers.get('Authorization')).toBeUndefined()
    expect(createRequest?.data).toBe(
      JSON.stringify({
        title: 'Cuộc họp MI tiếng Việt',
        description: 'Synthetic bounded Vietnamese MI meeting.',
      })
    )
  })

  it('accepts only same-origin Core configuration for the browser helper', () => {
    expect(isSameOriginCoreApi(undefined, 'https://web.example')).toBe(true)
    expect(isSameOriginCoreApi('/api/v1', 'https://web.example')).toBe(true)
    expect(
      isSameOriginCoreApi('https://web.example/api/v1', 'https://web.example')
    ).toBe(true)
    expect(
      isSameOriginCoreApi('https://core.example/api/v1', 'https://web.example')
    ).toBe(false)
    expect(isSameOriginCoreApi('https://%', 'https://web.example')).toBe(false)
  })

  it('uses the credentialed Core transport and CSRF header for a single job admission', async () => {
    const requests: Array<Parameters<AxiosAdapter>[0]> = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config)
      if (config.url === '/auth/csrf') {
        return response(config, envelope({ csrfToken: 'csrf-for-test' }))
      }
      if (config.url === '/auth/me') return response(config, envelope(identity))
      return response(config, envelope(job), 202)
    }

    await verifyOperatorSession(identity.userId)
    await expect(
      admitProcessingJob('meeting/1', 'media-1', 'job-admission-1')
    ).resolves.toEqual(job)

    const admission = requests[requests.length - 1]
    expect(admission?.url).toBe('/meetings/meeting%2F1/processing-jobs')
    expect(admission?.withCredentials).toBe(true)
    expect(admission?.headers.get('Idempotency-Key')).toBe('job-admission-1')
    expect(admission?.headers.get('X-CSRF-Token')).toBe('csrf-for-test')
    expect(admission?.headers.get('Authorization')).toBeUndefined()
    expect(admission?.data).toBe(JSON.stringify({ mediaId: 'media-1' }))
  })

  it('verifies the admitted job belongs to the operator and does not add a retry path', async () => {
    const postSpy = vi.spyOn(coreApi, 'post').mockResolvedValue(job)

    await expect(
      admitOperatorProcessingJob(
        'meeting/1',
        'media-1',
        'job-admission-operator-1',
        identity.userId
      )
    ).resolves.toEqual(job)
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/processing-jobs',
      { mediaId: 'media-1' },
      { headers: { 'Idempotency-Key': 'job-admission-operator-1' } }
    )
  })

  it('consumes an upload capability without returning or logging its URL, then finalizes once', async () => {
    const postSpy = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce({
        mediaId: 'media-1',
        status: 'PENDING_UPLOAD',
        uploadUrl: 'https://storage.example.invalid/opaque-capability',
        expiresAt: '2026-11-21T00:10:00Z',
        requiredContentType: 'audio/wav',
      })
      .mockResolvedValueOnce(media)
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)
    const body = new Blob(['abc'], { type: 'audio/wav' })

    const result = await uploadAndFinalizeMeetingMedia(
      'meeting/1',
      {
        originalFilename: ' meeting.wav ',
        contentType: 'audio/wav; codecs=pcm',
        expectedSizeBytes: 3,
        body,
      },
      'upload-1'
    )

    expect(result).toEqual(media)
    expect(JSON.stringify(result)).not.toContain('storage.example.invalid')
    expect(upload).toHaveBeenCalledWith(
      'https://storage.example.invalid/opaque-capability',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'audio/wav' },
        body,
      })
    )
    expect(postSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting%2F1/media/uploads',
      {
        sourceType: 'UPLOAD',
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      },
      { headers: { 'Idempotency-Key': 'upload-1' } }
    )
    expect(postSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting%2F1/media/media-1/finalize'
    )
  })

  it('does not PUT again when an idempotent upload intent is already available', async () => {
    const postSpy = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce({
        mediaId: 'media-1',
        status: 'AVAILABLE',
        uploadUrl: null,
        expiresAt: null,
        requiredContentType: 'audio/wav',
      })
      .mockResolvedValueOnce(media)
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)

    await expect(
      uploadAndFinalizeMeetingMedia(
        'meeting/1',
        {
          originalFilename: 'meeting.wav',
          contentType: 'audio/wav',
          expectedSizeBytes: 3,
          body: new Blob(['abc']),
        },
        'upload-replay'
      )
    ).resolves.toEqual(media)

    expect(upload).not.toHaveBeenCalled()
    expect(postSpy).toHaveBeenCalledTimes(2)
  })

  it('retains transcript and processing ETags and sends approved corrections with If-Match', async () => {
    const transcriptGetSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: transcript,
        meta: {},
        etag: '"transcript-etag"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: {
          id: 'segment-1',
          text: 'Xin chào mọi người',
          qualityStatus: 'HUMAN_CORRECTED',
          version: 1,
          correctedByUserId: identity.userId,
          correctedAt: '2026-11-21T00:05:00Z',
        },
        meta: {},
        etag: '"s-segment-1-1"',
      })
    const getJobSpy = vi.spyOn(coreApi, 'get').mockResolvedValue(job)

    const reviewed = await fetchMeetingTranscript('meeting/1')
    expect(reviewed.etag).toBe('"transcript-etag"')
    expect(transcriptSegmentEtag(reviewed.transcript.segments[0]!)).toBe(
      '"s-segment-1-0"'
    )
    await expect(fetchProcessingJob('job-1')).resolves.toEqual(job)

    await expect(
      applyApprovedTranscriptCorrection(
        'meeting/1',
        'segment-1',
        transcriptSegmentEtag(reviewed.transcript.segments[0]!),
        {
          text: ' Xin chào mọi người ',
          reason: 'Đã nghe lại bản ghi',
          operatorApproved: true,
        }
      )
    ).resolves.toMatchObject({ etag: '"s-segment-1-1"' })

    expect(transcriptGetSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/transcript',
      undefined
    )
    expect(getJobSpy).toHaveBeenCalledWith('/processing-jobs/job-1', undefined)
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/transcript/segments/segment-1',
      { text: 'Xin chào mọi người', reason: 'Đã nghe lại bản ghi' },
      { headers: { 'If-Match': '"s-segment-1-0"' } }
    )
  })

  it('reads a finalized Vietnamese transcript revision and computes the Core correction digest', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: transcript,
      meta: {},
      etag: '"t-transcript-1-0"',
    })

    await expect(
      fetchFinalizedTranscriptEvidence('meeting/1')
    ).resolves.toEqual({
      transcript,
      etag: '"t-transcript-1-0"',
      digest:
        'd86b55549a26c55c9b83e9b267ba3b87b9ce56e264bbcaa2f2b115de64172c7f',
    })
  })

  it('reviews Summary, Decision, and Action Item results without making proposal decisions', async () => {
    const summarySpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: summary,
        meta: {},
        etag: '"sum-summary-1-1"',
      })
    const listSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce({ data: [decision], meta: {} })
      .mockResolvedValueOnce({ data: [actionItem], meta: {} })

    await expect(readMeetingIntelligenceResults('meeting/1')).resolves.toEqual({
      summary: { summary, etag: '"sum-summary-1-1"' },
      decisions: [{ decision, etag: '"dec-decision-1-3"' }],
      actionItems: [{ actionItem, etag: '"a-action-1-2"' }],
    })

    expect(summarySpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/summary',
      undefined
    )
    expect(listSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting%2F1/decisions',
      undefined
    )
    expect(listSpy).toHaveBeenNthCalledWith(
      2,
      '/action-items?meetingId=meeting%2F1',
      undefined
    )
    expect(OPERATOR_MI_SUMMARY_CONTRACT).toEqual({
      extractionPromptVersion: 'summary-extraction-v2',
      evidenceSchemaVersion: 'summary-evidence-v1',
    })
  })

  it('keeps Decision and Action Item confirmation or rejection as separate explicit mutations', async () => {
    const postSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: { ...decision, status: 'CONFIRMED', version: 4 },
        meta: {},
        etag: '"dec-decision-1-4"',
      })
      .mockResolvedValueOnce({
        data: { ...decision, status: 'REJECTED', version: 4 },
        meta: {},
        etag: '"dec-decision-1-4"',
      })
      .mockResolvedValueOnce({
        data: { ...actionItem, status: 'OPEN', version: 3 },
        meta: {},
        etag: '"a-action-1-3"',
      })
      .mockResolvedValueOnce({
        data: { ...actionItem, status: 'CANCELLED', version: 3 },
        meta: {},
        etag: '"a-action-1-3"',
      })

    await confirmDecision('meeting/1', 'decision-1', '"dec-decision-1-3"')
    await rejectDecision('meeting/1', 'decision-1', '"dec-decision-1-3"')
    await confirmActionItem('action-1', actionItemEtag(actionItem))
    await rejectActionItem('action-1', actionItemEtag(actionItem))

    expect(postSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting%2F1/decisions/decision-1/confirm',
      undefined,
      { headers: { 'If-Match': '"dec-decision-1-3"' } }
    )
    expect(postSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting%2F1/decisions/decision-1/reject',
      undefined,
      { headers: { 'If-Match': '"dec-decision-1-3"' } }
    )
    expect(postSpy).toHaveBeenNthCalledWith(
      3,
      '/action-items/action-1/confirm',
      undefined,
      { headers: { 'If-Match': '"a-action-1-2"' } }
    )
    expect(postSpy).toHaveBeenNthCalledWith(
      4,
      '/action-items/action-1/reject',
      undefined,
      { headers: { 'If-Match': '"a-action-1-2"' } }
    )
  })
})
