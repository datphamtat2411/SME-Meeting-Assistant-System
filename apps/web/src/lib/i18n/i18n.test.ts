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

function leafEntries(value: object, prefix = ''): [string, string][] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof child === 'string'
      ? [[path, child] as [string, string]]
      : leafEntries(child, path)
  })
}

function semanticCatalog(language: 'en' | 'vi') {
  const entries = new Map(leafEntries(resources[language]))
  const result = new Map<string, string[]>()
  const pluralCategories = new Intl.PluralRules(language).resolvedOptions()
    .pluralCategories
  for (const [key, value] of entries) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '')
    const plural = base !== key && entries.has(base + '_other')
    const semanticKey = plural ? base : key
    if (plural) {
      for (const category of pluralCategories) {
        expect(entries.has(base + '_' + category), base + '_' + category).toBe(
          true
        )
      }
    }
    const placeholders = [
      ...new Set(
        [...value.matchAll(/{{\s*([\w.]+)\s*}}/g)].map((match) => match[1])
      ),
    ].sort()
    if (result.has(semanticKey)) {
      expect(placeholders, key).toEqual(result.get(semanticKey))
    } else {
      result.set(semanticKey, placeholders)
    }
  }
  return [...result.entries()].sort(([a], [b]) => a.localeCompare(b))
}

describe('UI localization', () => {
  it('keeps translation keys aligned between languages', () => {
    expect(semanticCatalog('vi')).toEqual(semanticCatalog('en'))
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
