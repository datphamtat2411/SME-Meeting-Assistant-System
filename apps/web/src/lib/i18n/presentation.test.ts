import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setUiLanguage } from './index'
import { UI_LANGUAGE_STORAGE_KEY } from './language-preference'
import {
  REQUIRED_VALIDATION_MESSAGE,
  errorCodeKey,
  localizedValidationMessage,
  meetingStatusKey,
  requestErrorKey,
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
  })

  it('localizes a stable validation marker, not arbitrary text', async () => {
    await setUiLanguage('vi')
    expect(localizedValidationMessage(REQUIRED_VALIDATION_MESSAGE)).toBe(
      'Trường này là bắt buộc.'
    )
    expect(localizedValidationMessage('Custom error')).toBe('Custom error')
  })
})
