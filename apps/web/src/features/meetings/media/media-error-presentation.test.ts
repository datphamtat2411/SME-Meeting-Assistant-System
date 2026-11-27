import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
import { MediaPresentationError, mediaErrorMessage } from './media-error-presentation'

describe('media error presentation', () => {
  it('does not expose raw browser diagnostics', () => {
    const marker = mediaErrorMessage(new Error('private storage diagnostic'))
    expect(localizedValidationMessage(marker)).toBe('The operation failed.')
  })

  it('resolves retained local errors in either language', () => {
    const marker = mediaErrorMessage(
      new MediaPresentationError('internal diagnostic', 'media:unsupportedFile')
    )
    expect(localizedValidationMessage(marker, (key, options) => i18n.t(key, { ...options, lng: 'en' }))).toBe('Choose a WAV, MP3, or AAC M4A recording.')
    expect(localizedValidationMessage(marker, (key, options) => i18n.t(key, { ...options, lng: 'vi' }))).toBe('Chọn bản ghi âm định dạng WAV, MP3 hoặc AAC M4A.')
  })
})
