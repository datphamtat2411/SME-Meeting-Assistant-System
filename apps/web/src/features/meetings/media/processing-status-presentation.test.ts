import { describe, expect, it } from 'vitest'
import { presentProcessingStatus } from './processing-status-presentation'

describe('processing status presentation', () => {
  it.each([
    ['PENDING', 'Pending', 'pending'],
    ['QUEUED', 'Pending', 'pending'],
    ['RUNNING', 'Processing', 'processing'],
    ['WAITING_FOR_REVIEW', 'Action required', 'action'],
    ['COMPLETED', 'Success', 'success'],
    ['COMPLETED_WITH_WARNINGS', 'Warning', 'warning'],
    ['FAILED', 'Failure', 'failure'],
    ['CANCELLED', 'Cancelled', 'neutral'],
    ['UNSUPPORTED_FUTURE_STATE', 'Unknown status', 'neutral'],
  ] as const)('maps %s truthfully', (status, label, kind) => {
    expect(presentProcessingStatus(status)).toEqual({ label, kind })
  })
})
