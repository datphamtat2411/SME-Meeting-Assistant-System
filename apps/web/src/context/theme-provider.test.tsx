import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { clearCookies } from '@/test-utils/cookies'
import { getCookie, setCookie } from '@/lib/cookies'
import { ThemeProvider, useTheme } from './theme-provider'

let systemMatches = false
let mediaListeners = new Set<(event: MediaQueryListEvent) => void>()
const nativeMatchMedia = window.matchMedia

function mockMatchMedia() {
  return (query: string) =>
    ({
      matches: systemMatches,
      media: query,
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void
      ) => mediaListeners.add(listener),
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void
      ) => mediaListeners.delete(listener),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

function ThemeState() {
  const { theme, resolvedTheme, setTheme, resetTheme } = useTheme()

  return (
    <div>
      <output data-testid='theme'>{theme}</output>
      <output data-testid='resolved-theme'>{resolvedTheme}</output>
      <button type='button' onClick={() => setTheme('light')}>
        Set light
      </button>
      <button type='button' onClick={() => setTheme('dark')}>
        Set dark
      </button>
      <button type='button' onClick={() => setTheme('system')}>
        Set system
      </button>
      <button type='button' onClick={resetTheme}>
        Reset theme
      </button>
    </div>
  )
}

async function renderThemeProvider(defaultTheme?: 'light' | 'dark' | 'system') {
  return await render(
    <ThemeProvider defaultTheme={defaultTheme}>
      <ThemeState />
    </ThemeProvider>
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    clearCookies()
    systemMatches = false
    mediaListeners = new Set()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: mockMatchMedia(),
    })
    document.documentElement.classList.remove('light', 'dark')
    const metaThemeColor = document.createElement('meta')
    metaThemeColor.setAttribute('name', 'theme-color')
    metaThemeColor.setAttribute('content', '#fff')
    document.head.appendChild(metaThemeColor)
  })

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: nativeMatchMedia,
    })
  })

  it('restores a valid cookie and applies its resolved theme to the document', async () => {
    setCookie('vite-ui-theme', 'dark')
    const screen = await renderThemeProvider()

    await expect.element(screen.getByTestId('theme')).toHaveTextContent('dark')
    await expect
      .element(screen.getByTestId('resolved-theme'))
      .toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector("meta[name='theme-color']")).toHaveAttribute(
      'content',
      '#020817'
    )
  })

  it('falls back to the configured default for an invalid persisted value', async () => {
    setCookie('vite-ui-theme', 'invalid')
    const screen = await renderThemeProvider('light')

    await expect.element(screen.getByTestId('theme')).toHaveTextContent('light')
    expect(getCookie('vite-ui-theme')).toBe('invalid')
  })

  it('persists light, dark, and system selections', async () => {
    const screen = await renderThemeProvider()

    await userEvent.click(screen.getByRole('button', { name: 'Set dark' }))
    await expect.poll(() => getCookie('vite-ui-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Set light' }))
    await expect.poll(() => getCookie('vite-ui-theme')).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Set system' }))
    await expect.poll(() => getCookie('vite-ui-theme')).toBe('system')
  })

  it('updates resolved theme and theme color when system preference changes', async () => {
    const screen = await renderThemeProvider()

    await userEvent.click(screen.getByRole('button', { name: 'Set system' }))
    systemMatches = true
    mediaListeners.forEach((listener) =>
      listener({ matches: true } as MediaQueryListEvent)
    )

    await expect
      .element(screen.getByTestId('resolved-theme'))
      .toHaveTextContent('dark')
    await expect.poll(() => document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector("meta[name='theme-color']")).toHaveAttribute(
      'content',
      '#020817'
    )
  })

  it('resets the cookie and configured default theme', async () => {
    const screen = await renderThemeProvider('light')

    await userEvent.click(screen.getByRole('button', { name: 'Set dark' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset theme' }))

    await expect.element(screen.getByTestId('theme')).toHaveTextContent('light')
    expect(getCookie('vite-ui-theme')).toBeUndefined()
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })
})
