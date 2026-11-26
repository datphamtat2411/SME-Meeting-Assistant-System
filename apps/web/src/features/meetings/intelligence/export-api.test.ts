import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  createMinutesExport,
  parseExportStatus,
  recoverMinutesExport,
} from './export-api'

const exportId = '55555555-5555-4555-8555-555555555555'
const meetingId = '11111111-1111-4111-8111-111111111111'

const status = {
  exportId,
  meetingId,
  format: 'PDF' as const,
  status: 'READY' as const,
  attemptCount: 1,
  createdAt: '2026-11-25T08:00:00Z',
  readyAt: '2026-11-25T08:01:00Z',
  safeErrorCode: null,
  freshness: 'CURRENT' as const,
  freshnessCheckedAt: '2026-11-25T08:01:00Z',
}

describe('export adapter identity contracts', () => {
  it('rejects status for a different meeting', () => {
    expect(() =>
      parseExportStatus(status, {
        exportId,
        meetingId: '66666666-6666-4666-8666-666666666666',
        format: 'PDF',
      })
    ).toThrowError(CoreApiError)
  })

  it('rejects contradictory freshness and invalid status metadata', () => {
    expect(() => parseExportStatus({ ...status, attemptCount: -1 })).toThrow(
      CoreApiError
    )
    expect(() =>
      parseExportStatus({ ...status, freshness: 'NOT_APPLICABLE' })
    ).toThrow(CoreApiError)
    expect(() =>
      parseExportStatus({ ...status, freshnessCheckedAt: null })
    ).toThrow(CoreApiError)
    expect(() =>
      parseExportStatus({ ...status, createdAt: 'invalid' })
    ).toThrow(CoreApiError)
    expect(
      parseExportStatus({
        ...status,
        freshness: 'UNKNOWN',
        freshnessCheckedAt: null,
      }).freshness
    ).toBe('UNKNOWN')
  })

  it('validates retry eligibility without treating older FAILED responses as terminal', () => {
    const failed = {
      ...status,
      status: 'FAILED',
      readyAt: null,
      safeErrorCode: 'EXPORT_STORAGE_UNAVAILABLE',
      freshness: 'NOT_APPLICABLE',
      freshnessCheckedAt: null,
    }
    expect(
      parseExportStatus({ ...failed, retryEligible: true }).retryEligible
    ).toBe(true)
    expect(
      parseExportStatus({ ...failed, retryEligible: false }).retryEligible
    ).toBe(false)
    expect(parseExportStatus(failed).retryEligible).toBeUndefined()
    expect(() =>
      parseExportStatus({ ...status, retryEligible: true })
    ).toThrow(CoreApiError)
  })

  it('uses a distinct recovery route and never creates on unavailable receipt', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      outcome: 'UNAVAILABLE',
      admission: null,
    })
    await expect(
      recoverMinutesExport(meetingId, 'PDF', 'original-key')
    ).resolves.toBeNull()
    expect(post).toHaveBeenCalledWith(
      '/meetings/' + meetingId + '/exports/recover',
      { format: 'PDF' },
      { headers: { 'Idempotency-Key': 'original-key' } }
    )
    post.mockRestore()
  })

  it('marks a cross-meeting admission receipt as uncertain', async () => {
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      exportId,
      meetingId: '66666666-6666-4666-8666-666666666666',
      format: 'PDF',
      status: 'PENDING',
      createdAt: '2026-11-25T08:00:00Z',
    })

    await expect(
      createMinutesExport(meetingId, 'PDF', 'export-intent')
    ).rejects.toMatchObject({
      code: 'EXPORT_ADMISSION_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
  })
})
