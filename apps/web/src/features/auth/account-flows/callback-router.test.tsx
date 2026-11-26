import { StrictMode } from 'react'
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { Route as setupRoute } from '@/routes/(auth)/account-setup'
import { completeAccountSetup } from '../account-flows-api'

vi.mock('../account-flows-api', () => ({
  completeAccountSetup: vi.fn(),
  resetAccountPassword: vi.fn(),
}))

describe('account setup browser routing', () => {
  it('preserves the router entry on sanitization and isolates a new callback', async () => {
    const originalUrl = window.location.href
    const originalState: unknown = window.history.state
    window.history.replaceState(
      null,
      '',
      '/account-setup?source=email#token=first'
    )
    const history = createBrowserHistory()
    const initialKey = history.location.state.__TSR_key
    const root = createRootRoute({ component: Outlet })
    const setup = createRoute({
      getParentRoute: () => root,
      path: '/account-setup',
      component: setupRoute.options.component,
    })
    const signIn = createRoute({
      getParentRoute: () => root,
      path: '/sign-in',
      component: () => <p>Sign in page</p>,
    })
    const router = createRouter({
      routeTree: root.addChildren([setup, signIn]),
      history,
    })
    vi.mocked(completeAccountSetup).mockResolvedValue(undefined)

    const screen = await render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    )
    try {
      const password = screen.getByLabelText('New password')
      await expect.element(password).toBeVisible()
      await expect.poll(() => history.location.hash).toBe('')
      expect(history.location.state.__TSR_key).toBe(initialKey)
      expect(history.location.search).toBe('?source=email')
      await userEvent.fill(password, 'old password input')

      history.push('/account-setup#token=second')
      history.flush()
      await expect.element(password).toHaveValue('')
      await expect.poll(() => history.location.hash).toBe('')
      const newPassword = 'new private activation password'
      await userEvent.fill(password, newPassword)
      await userEvent.fill(
        screen.getByLabelText('Confirm password'),
        newPassword
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Activate account' })
      )
      await expect
        .element(screen.getByRole('status'))
        .toHaveTextContent(/account is ready/i)
      expect(completeAccountSetup).toHaveBeenCalledExactlyOnceWith(
        'second',
        newPassword
      )

      await userEvent.click(
        screen.getByRole('link', { name: 'Continue to sign in' })
      )
      await expect.element(screen.getByText('Sign in page')).toBeVisible()
      history.back()
      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent(/missing or invalid/i)
    } finally {
      await screen.unmount()
      history.destroy()
      window.history.replaceState(originalState, '', originalUrl)
    }
  })
})
