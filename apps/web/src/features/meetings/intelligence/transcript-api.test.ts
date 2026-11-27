import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import {
  correctTranscriptSegment,
  mapSpeaker,
  reviewCoverageQuery,
  transcriptReviewQuery,
  transcriptSchema,
  transcriptSegmentEtag,
} from './transcript-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const transcriptId = '22222222-2222-4222-8222-222222222222'
const sourceMediaId = '33333333-3333-4333-8333-333333333333'
const processingJobId = '44444444-4444-4444-8444-444444444444'
const speakerId = '55555555-5555-4555-8555-555555555555'
const segmentId = '66666666-6666-4666-8666-666666666666'

const transcript = {
  id: transcriptId,
  meetingId,
  sourceMediaId,
  processingJobId,
  versionNumber: 1,
  languageCode: 'vi',
  status: 'READY',
  durationMs: 2000,
  finalizedAt: '2026-11-25T09:00:00Z',
  contentRevision: 7,
  segments: [
    {
      id: segmentId,
      ordinal: 0,
      startMs: 0,
      endMs: 1000,
      text: 'Xin chào',
      qualityStatus: 'HIGH',
      speakerClusterId: speakerId,
      speakerLabel: 'Speaker 1',
      version: 3,
      etag: '"opaque-segment-token"',
    },
  ],
} as const

describe('transcript API concurrency contracts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('captures the collection ETag without refreshing it during speaker mapping', async () => {
    const getWithMetaAndEtag = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: transcript,
        meta: {},
        etag: '"t-transcript-7"',
      })
    const patch = vi.spyOn(coreApi, 'patch').mockResolvedValue({})
    const query = transcriptReviewQuery(meetingId)
    const queryFn = query.queryFn
    if (!queryFn)
      throw new Error('Expected a transcript review query function.')

    const review = await queryFn({
      client: new QueryClient(),
      queryKey: query.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
      pageParam: undefined,
      direction: 'forward',
    })

    expect(review.etag).toBe('"t-transcript-7"')
    await mapSpeaker(
      meetingId,
      speakerId,
      '77777777-7777-4777-8777-777777777777',
      review.etag
    )

    expect(getWithMetaAndEtag).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith(
      `/meetings/${meetingId}/speaker-clusters/${speakerId}`,
      { userId: '77777777-7777-4777-8777-777777777777' },
      { headers: { 'If-Match': '"t-transcript-7"' } }
    )
  })

  it('uses the issued segment ETag for corrections and requires a collection token for mapping', async () => {
    const patch = vi.spyOn(coreApi, 'patch').mockResolvedValue({})
    const segment = transcript.segments[0]

    expect(transcriptSegmentEtag(segment)).toBe('"opaque-segment-token"')
    await correctTranscriptSegment(meetingId, segment, 'Updated', '')
    expect(patch).toHaveBeenCalledWith(
      `/meetings/${meetingId}/transcript/segments/${segmentId}`,
      { text: 'Updated', reason: null },
      { headers: { 'If-Match': '"opaque-segment-token"' } }
    )
    patch.mockClear()
    await expect(
      correctTranscriptSegment(meetingId, { id: segmentId }, 'Updated', '')
    ).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    await expect(mapSpeaker(meetingId, speakerId, null)).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })

    expect(patch).not.toHaveBeenCalled()
  })

  it('rejects an unsafe transcript timeline instead of rendering invented chronology', () => {
    const parsed = transcriptSchema.safeParse({
      ...transcript,
      segments: [
        {
          ...transcript.segments[0],
          startMs: 1500,
          endMs: 1000,
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects coverage observed across a transcript replacement', async () => {
    const etag = '"t-transcript-7"'
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: transcript, meta: {}, etag })
      .mockResolvedValueOnce({
        data: { ...transcript, contentRevision: 8 },
        meta: {},
        etag: '"t-transcript-8"',
      })
    const read = vi.spyOn(coreApi, 'get').mockResolvedValue([])
    const client = new QueryClient()
    const snapshot = { transcript: transcriptSchema.parse(transcript), etag }
    await expect(
      client.fetchQuery(reviewCoverageQuery(meetingId, snapshot))
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_EVIDENCE_CHANGED' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('rejects a transcript from a different meeting', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...transcript, meetingId: sourceMediaId },
      meta: {},
      etag: '"t-transcript-7"',
    })
    const client = new QueryClient()
    await expect(
      client.fetchQuery(transcriptReviewQuery(meetingId))
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
