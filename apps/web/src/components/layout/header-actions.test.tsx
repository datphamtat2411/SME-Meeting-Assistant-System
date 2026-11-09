import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { UserPresentationProvider } from './data/user-presentation'
import { HeaderActions } from './header-actions'

const canonicalUser = {
  displayName: 'Canonical User',
  email: 'canonical@example.test',
  initials: 'CU',
}

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SearchProvider>
          <UserPresentationProvider user={canonicalUser}>
            <HeaderActions />
          </UserPresentationProvider>
        </SearchProvider>
      </ThemeProvider>
    ),
  })
  const route = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    })
  const routeTree = rootRoute.addChildren([
    route('/'),
    route('/settings'),
    route('/settings/account'),
    route('/settings/notifications'),
    route('/settings/appearance'),
  ])

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('HeaderActions', () => {
  it('exposes usable command, theme, and user controls at mobile width', async () => {
    await page.viewport(390, 844)
    const screen = await render(<RouterProvider router={createTestRouter()} />)

    await expect
      .element(screen.getByRole('button', { name: 'Open command menu' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Toggle theme' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Open user menu' }))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Open command menu' })
    )
    await expect
      .element(screen.getByPlaceholder('Navigate to a page or command'))
      .toBeInTheDocument()
  })
})
