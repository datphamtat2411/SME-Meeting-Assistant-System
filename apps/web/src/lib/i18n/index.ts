import { createInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  isUiLanguage,
  persistUiLanguage,
  readUiLanguage,
  type UiLanguage,
} from './language-preference'
import { resources } from './resources'

export const i18n = createInstance()

// Bundled resources initialize synchronously, including in isolated UI tests.
void i18n.use(initReactI18next).init({
  resources,
  lng: readUiLanguage(),
  supportedLngs: [...UI_LANGUAGES],
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(resources.en),
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
})

function updateDocumentLanguage(language: string) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = isUiLanguage(language)
      ? language
      : DEFAULT_UI_LANGUAGE
  }
}

updateDocumentLanguage(i18n.resolvedLanguage ?? DEFAULT_UI_LANGUAGE)
i18n.on('languageChanged', updateDocumentLanguage)

export async function setUiLanguage(language: UiLanguage) {
  if (!isUiLanguage(language)) return
  await i18n.changeLanguage(language)
  if (i18n.resolvedLanguage === language) persistUiLanguage(language)
}

export function useUiTranslation() {
  return useTranslation(undefined, { i18n })
}
