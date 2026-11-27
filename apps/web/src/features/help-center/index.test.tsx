import { act } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { setUiLanguage } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { ThemeProvider } from '@/context/theme-provider'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { HelpCenter } from './index'

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider>
        <AuthenticatedLayout>
          <HelpCenter />
        </AuthenticatedLayout>
      </ThemeProvider>
    ),
  })
  const route = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    })

  return createRouter({
    routeTree: rootRoute.addChildren([
      route('/'),
      route('/help-center'),
      route('/settings'),
      route('/settings/account'),
      route('/settings/notifications'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/help-center'] }),
  })
}

afterEach(async () => {
  await setUiLanguage('en')
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

describe('Help Center', () => {
  it('switches the help content without changing its route', async () => {
    await setUiLanguage('en')
    const router = createTestRouter()
    const screen = await render(<RouterProvider router={router} />)
    await act(async () => {
      await setUiLanguage('vi')
    })
    await expect
      .element(screen.getByRole('heading', { name: 'Trung tâm trợ giúp' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('link', { name: 'Về trang Tổng quan' }))
      .toHaveAttribute('href', '/')
    expect(router.history.location.pathname).toBe('/help-center')
  })

  it('uses the authenticated shell and offers truthful Dashboard recovery', async () => {
    const router = createTestRouter()
    const screen = await render(<RouterProvider router={router} />)

    await expect
      .element(screen.getByRole('main'))
      .toHaveAttribute('id', 'content')
    await expect
      .element(screen.getByRole('heading', { name: 'Help Center' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/not available in this workspace/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Return to Dashboard' }))
      .toHaveAttribute('href', '/')
    await expect
      .element(screen.getByText('Coming Soon!', { exact: true }))
      .not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('link', { name: 'Return to Dashboard' })
    )
    await expect.poll(() => router.history.location.pathname).toBe('/')
  })
})
