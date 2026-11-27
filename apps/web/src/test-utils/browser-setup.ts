import { beforeEach } from 'vitest'
import { i18n } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'

// Existing business tests intentionally assert English accessible names.
// Production startup still reads the real browser preference (default: vi).
beforeEach(async () => {
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  if (i18n.resolvedLanguage !== 'en') await i18n.changeLanguage('en')
})
