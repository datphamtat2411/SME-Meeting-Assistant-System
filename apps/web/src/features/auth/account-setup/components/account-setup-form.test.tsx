import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent, type Locator } from 'vitest/browser'
import { completeAccountSetup } from '../account-setup-api'
import { AccountSetupForm } from './account-setup-form'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', async (orig) => {
  const actual = await orig<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('../account-setup-api', () => ({
  completeAccountSetup: vi.fn(),
}))

describe('AccountSetupForm', () => {
  let screen: RenderResult
  let passwordInput: Locator
  let confirmPasswordInput: Locator
  let submitButton: Locator

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(completeAccountSetup).mockResolvedValue()
  })

  it('renders password fields and validates the minimum password length', async () => {
    screen = await render(<AccountSetupForm token='signed-setup-token' />)
    passwordInput = screen.getByLabelText(/^Password$/i)
    confirmPasswordInput = screen.getByLabelText(/^Confirm password$/i)
    submitButton = screen.getByRole('button', { name: /^Set password$/i })

    await expect.element(passwordInput).toBeInTheDocument()
    await expect.element(confirmPasswordInput).toBeInTheDocument()

    await userEvent.fill(passwordInput, 'too-short')
    await userEvent.fill(confirmPasswordInput, 'too-short')
    await userEvent.click(submitButton)

    await expect
      .element(screen.getByText(/^Password must be at least 15 characters long\.$/i))
      .toBeInTheDocument()
    expect(completeAccountSetup).not.toHaveBeenCalled()
  })

  it('submits the token and redirects to sign-in after activation', async () => {
    screen = await render(<AccountSetupForm token='signed-setup-token' />)
    passwordInput = screen.getByLabelText(/^Password$/i)
    confirmPasswordInput = screen.getByLabelText(/^Confirm password$/i)
    submitButton = screen.getByRole('button', { name: /^Set password$/i })

    const password = 'a private password chosen by the user'

    await userEvent.fill(passwordInput, password)
    await userEvent.fill(confirmPasswordInput, password)
    await userEvent.click(submitButton)

    await vi.waitFor(() =>
      expect(completeAccountSetup).toHaveBeenCalledWith({
        token: 'signed-setup-token',
        password,
      })
    )
    await vi.waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/sign-in',
        replace: true,
      })
    )
  })

  it('does not submit when the setup token is absent', async () => {
    const missingTokenScreen = await render(<AccountSetupForm token={null} />)

    await expect
      .element(
        missingTokenScreen.getByText(
          /^This setup link is missing or invalid\.$/i
        )
      )
      .toBeInTheDocument()
    expect(completeAccountSetup).not.toHaveBeenCalled()
  })
})
