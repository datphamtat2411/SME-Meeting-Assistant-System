import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
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
    expect(presentProcessingStatus(status, i18n.getFixedT('en'))).toEqual({
      label,
      kind,
    })
  })

  it.each([
    ['PENDING', 'Chờ xử lý', 'pending'],
    ['QUEUED', 'Chờ xử lý', 'pending'],
    ['RUNNING', 'Đang xử lý', 'processing'],
    ['WAITING_FOR_REVIEW', 'Cần xem xét', 'action'],
    ['COMPLETED', 'Hoàn thành', 'success'],
    ['COMPLETED_WITH_WARNINGS', 'Hoàn thành có cảnh báo', 'warning'],
    ['FAILED', 'Xử lý thất bại', 'failure'],
    ['CANCELLED', 'Đã hủy', 'neutral'],
    ['UNSUPPORTED_FUTURE_STATE', 'Không rõ trạng thái', 'neutral'],
  ] as const)('localizes %s without changing its kind', (status, label, kind) => {
    expect(presentProcessingStatus(status, i18n.getFixedT('vi'))).toEqual({
      label,
      kind,
    })
  })
})
