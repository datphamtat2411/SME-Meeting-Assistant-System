import { StrictMode, act } from 'react'
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { Route as setupRoute } from '@/routes/(auth)/account-setup'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
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
    vi.mocked(completeAccountSetup).mockReset().mockResolvedValue(undefined)

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
      let finishFirst!: () => void
      vi.mocked(completeAccountSetup).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve
          })
      )
      const firstPassword = 'old private activation password'
      await userEvent.fill(password, firstPassword)
      await userEvent.fill(
        screen.getByLabelText('Confirm password'),
        firstPassword
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Activate account' })
      )
      await expect.element(password).toBeDisabled()
      expect(completeAccountSetup).toHaveBeenCalledExactlyOnceWith(
        'first',
        firstPassword
      )

      history.push('/account-setup#token=second')
      history.flush()
      await expect.element(password).toHaveValue('')
      await expect.poll(() => history.location.hash).toBe('')
      const newPassword = 'new private activation password'
      await userEvent.fill(password, newPassword)
      await act(async () => {
        finishFirst()
      })
      await expect.element(password).toHaveValue(newPassword)
      await expect.element(password).toBeEnabled()
      expect(completeAccountSetup).toHaveBeenCalledOnce()
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
      expect(completeAccountSetup).toHaveBeenCalledTimes(2)
      expect(completeAccountSetup).toHaveBeenLastCalledWith(
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
