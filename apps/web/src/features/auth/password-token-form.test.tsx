import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { AccountSetup } from './account-setup'
import { Otp } from './otp'
import { PasswordReset } from './reset-password'
import { SignUp } from './sign-up'

const completeAccountSetup = vi.hoisted(() => vi.fn())
const resetAccountPassword = vi.hoisted(() => vi.fn())
const requestSessionRevalidation = vi.hoisted(() => vi.fn())

vi.mock('./session/session-revalidation', () => ({
  requestSessionRevalidation,
  retrySessionRevalidation: vi.fn(),
  useSessionRevalidation: () => 'unauthenticated',
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: {
      children?: React.ReactNode
      to: string
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})

vi.mock('./account-flows-api', () => ({
  completeAccountSetup,
  resetAccountPassword,
}))

describe('password-token callback surfaces', () => {
  const originalUrl = window.location.href
  const originalState: unknown = window.history.state

  beforeEach(() => {
    vi.clearAllMocks()
    completeAccountSetup.mockResolvedValue(undefined)
    resetAccountPassword.mockResolvedValue(undefined)
  })

  afterEach(() => {
    window.history.replaceState(originalState, '', originalUrl)
  })

  it.each([
    ['/account-setup', AccountSetup],
    ['/sign-up', SignUp],
  ] as const)(
    'activates through the same workflow at %s',
    async (path, Page) => {
      const token = 'single-use-setup-capability'
      window.history.replaceState(
        { marker: 'preserved' },
        '',
        path + '?source=email#token=' + token
      )
      const screen = await render(
        <StrictMode>
          <Page />
        </StrictMode>
      )
      const password = 'a sufficiently long setup password'

      expect(window.location.hash).toBe('')
      expect(window.location.search).toBe('?source=email')
      expect(window.history.state).toEqual({ marker: 'preserved' })
      await userEvent.fill(screen.getByLabelText('New password'), password)
      await userEvent.fill(screen.getByLabelText('Confirm password'), password)
      await userEvent.click(
        screen.getByRole('button', { name: 'Activate account' })
      )
      await expect
        .element(screen.getByRole('status'))
        .toHaveTextContent(/account is ready/i)
      expect(completeAccountSetup).toHaveBeenCalledExactlyOnceWith(
        token,
        password
      )
      expect(resetAccountPassword).not.toHaveBeenCalled()
      await expect
        .element(screen.getByRole('link', { name: 'Continue to sign in' }))
        .toBeVisible()
    }
  )

  it('requires reopening the email after a sanitized callback is remounted', async () => {
    window.history.replaceState({}, '', '/account-setup#token=first')
    const first = await render(<AccountSetup />)
    await expect.element(first.getByLabelText('New password')).toBeVisible()
    expect(window.location.hash).toBe('')
    await first.unmount()

    const second = await render(<AccountSetup />)
    await expect
      .element(second.getByRole('alert'))
      .toHaveTextContent(/missing or invalid/i)
    expect(completeAccountSetup).not.toHaveBeenCalled()
  })

  it('shows a safe missing-link state without making a request', async () => {
    window.history.replaceState({}, '', '/account-setup#token=x&token=y')
    const screen = await render(<AccountSetup />)
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/missing or invalid/i)
    expect(window.location.hash).toBe('')
    expect(completeAccountSetup).not.toHaveBeenCalled()
  })

  it.each([
    ['/reset-password', PasswordReset],
    ['/otp', Otp],
  ] as const)('resets through the same workflow at %s', async (path, Page) => {
    const token = 'single-use-reset-capability'
    window.history.replaceState({}, '', path + '#token=' + token)
    const screen = await render(<Page />)
    const password = 'a sufficiently long reset password'

    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Reset password' })
    )
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/password was set successfully/i)
    expect(resetAccountPassword).toHaveBeenCalledExactlyOnceWith(
      token,
      password
    )
    expect(completeAccountSetup).not.toHaveBeenCalled()
    expect(requestSessionRevalidation).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('')
  })

  it('revalidates after an uncertain reset without permitting another submission', async () => {
    resetAccountPassword.mockRejectedValueOnce(new Error('network'))
    window.history.replaceState({}, '', '/reset-password#token=uncertain')
    const screen = await render(<PasswordReset />)
    const password = 'a sufficiently long reset password'
    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Reset password' })
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/may already have/i)
    expect(requestSessionRevalidation).toHaveBeenCalledOnce()
    expect(resetAccountPassword).toHaveBeenCalledOnce()
    await expect
      .element(screen.getByRole('button', { name: 'Reset password' }))
      .not.toBeInTheDocument()
  })
})
