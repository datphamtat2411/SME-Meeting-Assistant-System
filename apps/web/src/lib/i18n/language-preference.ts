export const UI_LANGUAGES = ['en', 'vi'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]

// Switch to Vietnamese in LOC-05, when feature coverage is complete.
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en'
export const UI_LANGUAGE_STORAGE_KEY = 'sme-ui-language'

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'en' || value === 'vi'
}

export function readUiLanguage(): UiLanguage {
  try {
    const value = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    return isUiLanguage(value) ? value : DEFAULT_UI_LANGUAGE
  } catch {
    return DEFAULT_UI_LANGUAGE
  }
}

export function persistUiLanguage(language: UiLanguage): void {
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language)
  } catch {
    // The in-memory language still works when browser storage is unavailable.
  }
}
