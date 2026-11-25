import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { createMinutesExport, parseExportStatus } from './export-api'

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
