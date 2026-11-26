import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { getCookie } from '@/lib/cookies'
import { FontProvider, useFont } from '@/context/font-provider'
import { ThemeProvider, useTheme } from '@/context/theme-provider'
import { AppearanceForm } from './appearance-form'

function ExternalControls() {
  const { setTheme, theme } = useTheme()
  const { setFont, font } = useFont()
  return (
    <>
      <button onClick={() => setTheme('dark')}>External dark</button>
      <button onClick={() => setTheme('light')}>External light</button>
      <button onClick={() => setFont('manrope')}>External font</button>
      <output aria-label='Applied theme'>{theme}</output>
      <output aria-label='Applied font'>{font}</output>
    </>
  )
}

describe('Appearance draft and applied state', () => {
  beforeEach(() => clearCookies())

  it('tracks external changes without overwriting unrelated settings', async () => {
    const screen = await render(
      <ThemeProvider>
        <FontProvider>
          <ExternalControls />
          <AppearanceForm />
        </FontProvider>
      </ThemeProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'External dark' }))
    await expect
      .element(screen.getByRole('radio', { name: 'Dark' }))
      .toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'System' }))
    await userEvent.click(screen.getByRole('button', { name: 'External font' }))
    await expect
      .element(screen.getByRole('radio', { name: 'System' }))
      .toBeChecked()
    await expect.element(screen.getByRole('combobox')).toHaveValue('manrope')
    await userEvent.click(
      screen.getByRole('button', { name: 'Update preferences' })
    )
    expect(getCookie('vite-ui-theme')).toBe('system')
    expect(getCookie('font')).toBe('manrope')
    await expect
      .element(screen.getByRole('button', { name: 'Update preferences' }))
      .toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'External light' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await expect
      .element(screen.getByRole('radio', { name: 'Light' }))
      .toBeChecked()
  })
})
