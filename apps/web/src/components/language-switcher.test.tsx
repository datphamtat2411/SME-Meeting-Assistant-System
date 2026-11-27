import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { setUiLanguage, useUiTranslation } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { LanguageSwitcher } from './language-switcher'

afterEach(async () => {
  await setUiLanguage('en')
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

function Example() {
  const { t } = useUiTranslation()
  const [draft, setDraft] = useState('')
  return (
    <>
      <LanguageSwitcher />
      <label>
        {t('navigation:meetings')}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </>
  )
}

describe('LanguageSwitcher', () => {
  it('switches language without resetting the mounted draft', async () => {
    await setUiLanguage('en')
    const screen = await render(<Example />)
    await userEvent.fill(screen.getByRole('textbox'), 'Sprint planning')
    await userEvent.click(
      screen.getByRole('button', { name: 'Interface language' })
    )
    await userEvent.click(
      screen.getByRole('menuitemradio', { name: 'Tiếng Việt' })
    )
    await expect
      .element(screen.getByLabelText('Cuộc họp'))
      .toHaveValue('Sprint planning')
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('vi')
  })
})
