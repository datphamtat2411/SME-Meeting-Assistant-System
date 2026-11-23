import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { Otp } from './otp'
import { SignUp } from './sign-up'

const completeAccountSetup = vi.hoisted(() => vi.fn())
const resetAccountPassword = vi.hoisted(() => vi.fn())

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
  validNewPassword: (value: string) =>
    Array.from(value).length >= 15 && Array.from(value).length <= 128,
}))

describe('password-token callback surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    completeAccountSetup.mockResolvedValue(undefined)
    resetAccountPassword.mockResolvedValue(undefined)
  })

  afterEach(() => {
    window.history.pushState({}, '', '/sign-in')
  })

  it('keeps the legacy sign-up callback on the Core account-setup operation', async () => {
    const token = 'legacy-setup-capability'
    window.history.pushState({}, '', `/sign-up#token=${token}`)
    const screen = await render(<SignUp />)
    const password = 'a sufficiently long setup password'

    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Activate account' })
    )

    await vi.waitFor(() =>
      expect(completeAccountSetup).toHaveBeenCalledWith(token, password)
    )
    expect(resetAccountPassword).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  it('keeps the otp callback on the Core single-use password-reset operation', async () => {
    const token = 'single-use-reset-capability'
    window.history.pushState({}, '', `/otp#token=${token}`)
    const screen = await render(<Otp />)
    const password = 'a sufficiently long reset password'

    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Reset password' })
    )

    await vi.waitFor(() =>
      expect(resetAccountPassword).toHaveBeenCalledWith(token, password)
    )
    expect(completeAccountSetup).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })
})
