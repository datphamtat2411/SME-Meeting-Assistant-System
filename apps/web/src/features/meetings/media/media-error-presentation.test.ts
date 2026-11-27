import { describe, expect, it } from 'vitest'
import { i18n, setUiLanguage } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
import {
  MediaPresentationError,
  mediaErrorMessage,
  processingErrorDescription,
} from './media-error-presentation'

describe('media error presentation', () => {
  it('localizes known processing errors and hides unknown diagnostics', async () => {
    try {
      for (const language of ['en', 'vi'] as const) {
        await setUiLanguage(language)
        expect(processingErrorDescription(new Error('private diagnostic'))).toBe(
          i18n.t('processing:operationFailed')
        )
        expect(
          processingErrorDescription(
            new MediaPresentationError(
              'private identity diagnostic',
              'processing:operationIdentityUnavailable'
            )
          )
        ).toBe(i18n.t('processing:operationIdentityUnavailable'))
      }
    } finally {
      await setUiLanguage('en')
    }
  })

  it('does not expose raw browser diagnostics', () => {
    const marker = mediaErrorMessage(new Error('private storage diagnostic'))
    expect(localizedValidationMessage(marker)).toBe('The operation failed.')
  })

  it('resolves retained local errors in either language', () => {
    const marker = mediaErrorMessage(
      new MediaPresentationError('internal diagnostic', 'media:unsupportedFile')
    )
    expect(
      localizedValidationMessage(marker, (key, options) =>
        i18n.t(key, { ...options, lng: 'en' })
      )
    ).toBe('Choose a WAV, MP3, or AAC M4A recording.')
    expect(
      localizedValidationMessage(marker, (key, options) =>
        i18n.t(key, { ...options, lng: 'vi' })
      )
    ).toBe('Chọn bản ghi âm định dạng WAV, MP3 hoặc AAC M4A.')
  })
})
