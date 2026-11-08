import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { ThemeProvider } from '@/context/theme-provider'
import { AuthenticatedRouteFallback } from '@/components/layout/authenticated-route-fallback'
import { GeneralError } from './general-error'
import { NotFoundError } from './not-found-error'

function createTestRouter(
  component: React.ReactNode,
  initialPath = '/',
  additionalPaths: string[] = []
) {
  const rootRoute = createRootRoute({
    component: () => component,
  })
  const paths = Array.from(new Set(['/', initialPath, ...additionalPaths]))
  const routeTree = rootRoute.addChildren(
    paths.map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => null,
      })
    )
  )

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
}

describe('error pages', () => {
  it('uses the router reset callback and provides Dashboard recovery', async () => {
    const reset = vi.fn()
    const router = createTestRouter(<GeneralError reset={reset} />, '/broken')
    const screen = await render(<RouterProvider router={router} />)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reset).toHaveBeenCalledOnce()

    await userEvent.click(
      screen.getByRole('button', { name: 'Go to Dashboard' })
    )
    await expect.poll(() => router.history.location.pathname).toBe('/')
  })

  it('keeps the invalid route context in not-found recovery copy', async () => {
    const router = createTestRouter(<NotFoundError />, '/missing-page')
    const screen = await render(<RouterProvider router={router} />)

    await expect.element(screen.getByText('/missing-page')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Go to Dashboard' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Go Back' }))
      .toBeDisabled()
  })

  it('preserves the authenticated shell around route fallbacks', async () => {
    await page.viewport(1280, 800)
    const router = createTestRouter(
      <ThemeProvider>
        <AuthenticatedRouteFallback>
          <p>Fallback content</p>
        </AuthenticatedRouteFallback>
      </ThemeProvider>
    )
    const screen = await render(<RouterProvider router={router} />)

    await expect
      .element(screen.getByRole('main'))
      .toHaveAttribute('id', 'content')
    await expect
      .element(screen.getByRole('link', { name: 'SME Meeting Assistant home' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Open command menu' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Fallback content'))
      .toBeInTheDocument()
  })
})
