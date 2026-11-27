import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { setUiLanguage } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { SearchProvider } from '@/context/search-provider'
import { Search } from '@/components/search'
import type { AuthContext } from '@/features/auth/session/current-user'

const COMMAND_MENU_PLACEHOLDER = 'Navigate to a page or command'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setTheme: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({ setTheme: mocks.setTheme }),
}))

type ShortcutModifier = 'Control' | 'Meta'

async function renderWithSearchProvider(
  children: React.ReactNode = null,
  identity?: AuthContext
) {
  return await render(
    <SearchProvider identity={identity}>{children}</SearchProvider>
  )
}

const identity: AuthContext = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'actor@example.test',
  displayName: 'Actor',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientType: 'WEB',
    createdAt: '2026-11-24T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-11-24T00:00:00Z',
  },
}

/**
 * Open the palette by shortcut, retrying while the keydown listener may not be mounted yet.
 * Waits between attempts so a successful toggle is not immediately undone by a second chord.
 */
async function openCommandPalette(
  screen: RenderResult,
  modifier: ShortcutModifier = 'Control'
) {
  await vi.waitFor(
    async () => {
      const isCommandPaletteOpen =
        document.querySelector(
          `[placeholder="${COMMAND_MENU_PLACEHOLDER}"]`
        ) !== null

      if (!isCommandPaletteOpen) {
        await userEvent.keyboard(`{${modifier}>}k{/${modifier}}`)
      }

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    },
    { interval: 50, timeout: 5000 }
  )
}

describe('SearchProvider and CommandMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await setUiLanguage('en')
    localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  })

  it('renders the command palette when the palette is open', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByText } = screen

    await openCommandPalette(screen)

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toBeInTheDocument()
    await expect
      .element(getByText('Appearance', { exact: true }))
      .toBeInTheDocument()
    await expect.element(getByText('Light')).toBeInTheDocument()
    await expect.element(getByText('Dark')).toBeInTheDocument()
    await expect.element(getByText('System')).toBeInTheDocument()
    await expect.element(getByText('Dashboard')).toBeInTheDocument()
    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toHaveFocus()
  })

  it.each([
    undefined,
    'EMPLOYEE',
    'DEPARTMENT_MANAGER',
    'ADMINISTRATOR',
  ] as const)('matches sidebar member visibility for %s', async (role) => {
    await setUiLanguage('vi')
    const screen = await renderWithSearchProvider(
      <Search />,
      role ? { ...identity, globalRole: role } : undefined
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở menu tìm kiếm' })
    )
    const memberOption = screen.getByRole('option', {
      name: 'Thành viên',
      exact: true,
    })
    if (role === 'ADMINISTRATOR' || role === 'DEPARTMENT_MANAGER') {
      await expect.element(memberOption).toBeInTheDocument()
    } else {
      await expect.element(memberOption).not.toBeInTheDocument()
    }
    await expect
      .element(screen.getByRole('option', { name: 'Phòng họp' }))
      .toBeInTheDocument()
  })

  it('does not show the dialog content when search is closed', async () => {
    const { getByPlaceholder } = await renderWithSearchProvider()

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it.each([
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
  ] as const)(
    'opens the command menu when %s + K is pressed',
    async (_label, modifier) => {
      const screen = await renderWithSearchProvider()

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .not.toBeInTheDocument()

      await openCommandPalette(screen, modifier)

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    }
  )

  it('navigates to a top-level route and closes the palette when a nav item is selected', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('Meetings'))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/meetings' })
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('navigates for nested sidebar items (group with sub-items)', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByRole } = screen

    await openCommandPalette(screen)

    await userEvent.click(getByRole('option', { name: 'Settings Account' }))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/account' })
    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('selects a filtered destination with arrow keys and Enter', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    const input = screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)
    await userEvent.fill(input, 'General Meetings /meetings')
    await expect
      .element(screen.getByRole('option', { name: 'Meeting Rooms' }))
      .not.toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/meetings' })
    await expect.element(input).not.toBeInTheDocument()
  })

  it.each(['Cuộc họp', 'cuoc hop'])(
    'navigates by Vietnamese label: %s',
    async (query) => {
      await setUiLanguage('vi')
      const screen = await renderWithSearchProvider(<Search />)
      await userEvent.click(
        screen.getByRole('button', { name: 'Mở menu tìm kiếm' })
      )
      const input = screen.getByPlaceholder('Tìm trang hoặc lệnh')
      await userEvent.fill(input, query)
      await expect
        .element(screen.getByRole('option', { name: 'Cuộc họp', exact: true }))
        .toBeInTheDocument()
      await expect
        .element(screen.getByRole('option', { name: 'Phòng họp' }))
        .not.toBeInTheDocument()
      await userEvent.keyboard('{ArrowDown}{Enter}')

      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
        to: '/meetings',
      })
      await expect.element(input).not.toBeInTheDocument()
    }
  )

  it('finds Vietnamese aliases while English is active', async () => {
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    const input = screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)
    await userEvent.fill(input, 'cuoc hop')
    await expect
      .element(screen.getByRole('option', { name: 'Meetings', exact: true }))
      .toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/meetings',
    })
  })

  it('applies theme and closes the palette when a theme command is chosen', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('Dark'))

    expect(mocks.setTheme).toHaveBeenCalledWith('dark')
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('shows empty state when the filter matches nothing', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.fill(
      screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER),
      'zzzz-no-match-xxxx'
    )

    await expect
      .element(screen.getByText('No matching pages or appearance commands.'))
      .toBeInTheDocument()
  })

  it('closes with Escape and restores focus to the invoking trigger', async () => {
    const screen = await renderWithSearchProvider(<Search />)
    const trigger = screen.getByRole('button', { name: 'Open command menu' })

    await userEvent.click(trigger)
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toHaveFocus()

    await userEvent.keyboard('{Escape}')

    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
    await expect.element(trigger).toHaveFocus()
  })
})
