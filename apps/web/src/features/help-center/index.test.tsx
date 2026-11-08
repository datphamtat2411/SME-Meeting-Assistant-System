import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
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

describe('Help Center', () => {
  it('uses the authenticated shell and offers truthful Dashboard recovery', async () => {
    const router = createTestRouter()
    const screen = await render(<RouterProvider router={router} />)

    await expect.element(screen.getByRole('main')).toHaveAttribute('id', 'content')
    await expect.element(screen.getByRole('heading', { name: 'Help Center' })).toBeInTheDocument()
    await expect
      .element(screen.getByText(/not available in this workspace/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Return to Dashboard' }))
      .toHaveAttribute('href', '/')
    await expect
      .element(screen.getByText('Coming Soon!', { exact: true }))
      .not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'Return to Dashboard' }))
    await expect.poll(() => router.history.location.pathname).toBe('/')
  })
})
