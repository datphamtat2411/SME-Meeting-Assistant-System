import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setUiLanguage } from './index'
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGE_STORAGE_KEY,
  readUiLanguage,
} from './language-preference'
import { resources } from './resources'

afterEach(async () => {
  await setUiLanguage(DEFAULT_UI_LANGUAGE)
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

function leafKeys(value: object, prefix = ''): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return typeof child === 'string' ? [path] : leafKeys(child, path)
    })
    .sort()
}

describe('UI localization', () => {
  it('keeps translation keys aligned between languages', () => {
    expect(leafKeys(resources.vi)).toEqual(leafKeys(resources.en))
  })

  it('changes UI labels and persists only the selected language', async () => {
    await setUiLanguage('vi')
    expect(i18n.t('navigation:meetings')).toBe('Cuộc họp')
    expect(document.documentElement.lang).toBe('vi')
    expect(readUiLanguage()).toBe('vi')
    await setUiLanguage('en')
    expect(i18n.t('navigation:meetings')).toBe('Meetings')
    expect(document.documentElement.lang).toBe('en')
  })

  it('rejects invalid saved language values', () => {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'vi-VN')
    expect(readUiLanguage()).toBe(DEFAULT_UI_LANGUAGE)
  })
})
