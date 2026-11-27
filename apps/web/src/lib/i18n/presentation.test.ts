import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setUiLanguage } from './index'
import { UI_LANGUAGE_STORAGE_KEY } from './language-preference'
import {
  INVALID_EMAIL_VALIDATION_MESSAGE,
  REQUIRED_VALIDATION_MESSAGE,
  errorCodeKey,
  featureValidationMessage,
  operationErrorFormMessage,
  requestErrorFormMessage,
  UiPresentationError,
  lengthValidationMessage,
  localizedValidationMessage,
  meetingStatusKey,
  requestErrorKey,
  requestStatusErrorKey,
  roleKey,
} from './presentation'

afterEach(async () => {
  await setUiLanguage('en')
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

describe('localized presentation mappings', () => {
  it('uses stable codes without altering business values', async () => {
    const status = 'SCHEDULED'
    const role = 'EMPLOYEE'
    await setUiLanguage('vi')
    expect(i18n.t(meetingStatusKey(status))).toBe('Đã lên lịch')
    expect(i18n.t(roleKey(role))).toBe('Nhân viên')
    expect(status).toBe('SCHEDULED')
    expect(role).toBe('EMPLOYEE')
  })

  it('recognizes only owned error codes and preserves unknown messages', () => {
    expect(errorCodeKey('AUTH_INVALID_CREDENTIALS')).toBe(
      'errors:invalidCredentials'
    )
    expect(errorCodeKey('toString')).toBeUndefined()
    expect(requestErrorKey({ status: 404 })).toBe('errors:notFound')
    expect(requestErrorKey({ status: 412 })).toBe('errors:stale')
    expect(requestErrorKey({ isNetworkError: true })).toBe('errors:network')
    expect(requestErrorKey({ code: 'MEETING_CUSTOM_ERROR' })).toBeUndefined()
    expect(
      requestErrorKey({ code: 'MEETING_CUSTOM_ERROR', status: 409 })
    ).toBeUndefined()
    expect(requestErrorKey({ code: 'VALIDATION_FAILED' })).toBe(
      'errors:validation'
    )
    expect(requestErrorKey({ status: 429 })).toBeUndefined()
    expect(requestStatusErrorKey(429)).toBe('errors:rateLimit')
    expect(requestStatusErrorKey(503)).toBe('errors:serviceUnavailable')
    expect(requestErrorKey({ code: 'MALFORMED_RESPONSE' })).toBe(
      'errors:malformedResponse'
    )
  })

  it('renders a retained feature message and its values in the current language', async () => {
    const key = 'meetings:participant_removeMismatch'
    const name = 'Nguyễn Văn A'
    const marker = featureValidationMessage(key, { name })
    await setUiLanguage('en')
    const english = localizedValidationMessage(marker)
    expect(english).toContain(name)
    expect(english).toContain('No mutation was retried.')
    await setUiLanguage('vi')
    const vietnamese = localizedValidationMessage(marker)
    expect(vietnamese).toContain(name)
    expect(vietnamese).toContain('Không gửi lại yêu cầu thay đổi.')
    expect(vietnamese).not.toBe(english)
    expect(localizedValidationMessage('validation.params:{bad')).toBe(
      'validation.params:{bad'
    )
    const malformed = 'validation.params:["meetings:participant_removeMismatch",{"name":{}}]'
    expect(localizedValidationMessage(malformed)).toBe(malformed)
    expect(localizedValidationMessage('validation.key:missing:key')).toBe(
      'validation.key:missing:key'
    )
  })

  it('preserves owned local error markers and keeps public conflict details', async () => {
    const local = new UiPresentationError('action-items:noChanges')
    const message = operationErrorFormMessage(local)
    await setUiLanguage('vi')
    expect(localizedValidationMessage(message)).toBe('Không có thay đổi công việc để lưu.')
    expect(requestErrorFormMessage({ status: 409, code: 'RESOURCE_CONFLICT', message: 'Room is already reserved.' })).toBe('Room is already reserved.')
    expect(localizedValidationMessage(requestErrorFormMessage({ status: 403, message: 'Private account detail' }))).toBe(i18n.t('errors:forbidden'))
  })

  it('localizes a stable validation marker, not arbitrary text', async () => {
    await setUiLanguage('vi')
    expect(localizedValidationMessage(REQUIRED_VALIDATION_MESSAGE)).toBe(
      'Trường này là bắt buộc.'
    )
    expect(localizedValidationMessage('Custom error')).toBe('Custom error')
    expect(localizedValidationMessage(INVALID_EMAIL_VALIDATION_MESSAGE)).toBe(
      'Nhập địa chỉ email hợp lệ.'
    )
    const marker = lengthValidationMessage('minLength', 15)
    expect(localizedValidationMessage(marker)).toBe('Nhập ít nhất 15 ký tự.')
    await setUiLanguage('en')
    expect(localizedValidationMessage(marker)).toBe(
      'Enter at least 15 characters.'
    )
    expect(
      localizedValidationMessage(lengthValidationMessage('maxLength', 1))
    ).toBe('Enter no more than 1 character.')
    expect(localizedValidationMessage('validation.minLength:-1')).toBe(
      'validation.minLength:-1'
    )
  })
})
