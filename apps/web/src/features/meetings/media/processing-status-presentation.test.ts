import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
import {
  presentProcessingFailure,
  presentProcessingJobType,
  presentProcessingStage,
  presentProcessingStatus,
} from './processing-status-presentation'

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
    ['WAITING_FOR_REVIEW', 'Cần rà soát', 'action'],
    ['COMPLETED', 'Hoàn thành', 'success'],
    ['COMPLETED_WITH_WARNINGS', 'Hoàn thành có cảnh báo', 'warning'],
    ['FAILED', 'Xử lý thất bại', 'failure'],
    ['CANCELLED', 'Đã hủy', 'neutral'],
    ['UNSUPPORTED_FUTURE_STATE', 'Không rõ trạng thái', 'neutral'],
  ] as const)(
    'localizes %s without changing its kind',
    (status, label, kind) => {
      expect(presentProcessingStatus(status, i18n.getFixedT('vi'))).toEqual({
        label,
        kind,
      })
    }
  )
})

describe('processing stage and job labels', () => {
  it('translates known codes and retains unknown future codes', () => {
    const t = i18n.getFixedT('vi')
    expect(presentProcessingStage('TRANSCRIPTION', t)).toBe('Nhận dạng lời nói')
    expect(presentProcessingStage('TRANSCRIPT_REVIEW', t)).toBe(
      'Rà soát bản ghi lời thoại'
    )
    expect(presentProcessingStage('FUTURE_STAGE', t)).toBe('FUTURE_STAGE')
    expect(presentProcessingJobType('OFFLINE_MEETING_PROCESSING', t)).toBe(
      'Xử lý cuộc họp'
    )
    expect(presentProcessingJobType('FUTURE_JOB', t)).toBe('FUTURE_JOB')
  })
})

describe('processing failure detail', () => {
  it.each([
    ['STAGE_LEASE_EXPIRED', 'Tác vụ ngừng báo cáo tiến độ.'],
    ['WORKER_DELIVERY_EXHAUSTED', 'Cần khôi phục tác vụ theo xác nhận từ máy chủ.'],
    ['ASR_FAILED', 'Nhận dạng lời nói thất bại.'],
    ['TRANSCRIPTION_TEMPORARY', 'Nhận dạng lời nói thất bại.'],
    ['TRANSCRIPTION_EVIDENCE_INVALID', 'Không thể xác minh bằng chứng bản ghi.'],
    ['LLM_CORRECTION_FAILED', 'Hiệu chỉnh bản ghi theo ngữ cảnh thất bại.'],
    ['DIARIZATION_FAILED', 'Phân biệt người nói thất bại.'],
    ['DIARIZATION_SOURCE_STALE', 'Nguồn phân biệt người nói đã thay đổi.'],
    ['SUMMARY_FAILED', 'Tạo bản tóm tắt cuộc họp thất bại.'],
    ['SUMMARY_PROVIDER_FAILURE', 'Tạo bản tóm tắt cuộc họp thất bại.'],
    ['PROCESSING_DISPATCH_FAILED', 'Không thể chuyển tác vụ sang hệ thống xử lý.'],
  ])('localizes the Core failure code %s', (code, label) => {
    expect(presentProcessingFailure(code, null, i18n.getFixedT('vi'))).toBe(label)
    expect(presentProcessingFailure(code, null, i18n.getFixedT('en'))).not.toMatch(/^processing:/)
  })

  it('retains public details for future codes and never claims success', () => {
    const t = i18n.getFixedT('vi')
    expect(presentProcessingFailure('FUTURE', 'Public detail.', t)).toBe(
      'Public detail.'
    )
    expect(presentProcessingFailure(null, null, t)).toBe('Xử lý thất bại')
  })
})
