import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { type Locator, userEvent } from 'vitest/browser'
import { CoreApiError } from '@/lib/core-api'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { UserAuthForm } from './user-auth-form'

const FORM_MESSAGES = {
  emailEmpty: 'Please enter your email.',
  passwordEmpty: 'Please enter your password.',
} as const

const navigate = vi.fn()
const signInMock = vi.hoisted(() => vi.fn())

vi.mock('../sign-in-api', () => ({ signIn: signInMock }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      children,
      to,
      className,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      className?: string
    }) => (
      <a href={to} className={className} {...rest}>
        {children}
      </a>
    ),
  }
})

describe('UserAuthForm', () => {
  let screen: RenderResult
  let queryClient: QueryClient
  let emailInput: Locator
  let passwordInput: Locator
  let signInButton: Locator
  let forgotPasswordLink: Locator

  beforeEach(async () => {
    vi.clearAllMocks()
    queryClient = new QueryClient()
    signInMock.mockResolvedValue({
      sessionStatus: 'ACTIVE',
      csrfToken: 'rotated-csrf-token',
    })
    screen = await render(
      <QueryClientProvider client={queryClient}>
        <UserAuthForm />
      </QueryClientProvider>
    )
    emailInput = screen.getByRole('textbox', { name: /^Email$/i })
    passwordInput = screen.getByLabelText(/^Password$/i)
    signInButton = screen.getByRole('button', { name: /^Sign in$/i })
    forgotPasswordLink = screen.getByText(/^Forgot password\?$/i)
  })

  it('renders fields, submit button, and forgot password link without social login', async () => {
    await expect.element(emailInput).toBeInTheDocument()
    await expect.element(passwordInput).toBeInTheDocument()
    await expect.element(signInButton).toBeInTheDocument()
    await expect.element(forgotPasswordLink).toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: /GitHub/i }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: /Facebook/i }))
      .not.toBeInTheDocument()
  })

  it('shows validation messages when submitting empty form', async () => {
    await userEvent.click(signInButton)

    await expect
      .element(screen.getByText(FORM_MESSAGES.emailEmpty))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(FORM_MESSAGES.passwordEmpty))
      .toBeInTheDocument()
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('uses backend-compatible email validation', async () => {
    await userEvent.fill(emailInput, 'not-an-email')
    await userEvent.fill(passwordInput, 'x')

    await userEvent.click(signInButton)

    await expect.element(screen.getByText(/valid email/i)).toBeInTheDocument()
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('submits a short but nonempty password and navigates after an active session', async () => {
    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'x')

    await userEvent.click(signInButton)

    await vi.waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith({
        email: 'a@b.com',
        password: 'x',
      })
    )
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('removes the cached identity before navigating after sign-in', async () => {
    queryClient.setQueryData(currentUserQueryKey, {
      displayName: 'Stale identity',
    })

    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'x')
    await userEvent.click(signInButton)

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined()
  })

  it('navigates to a safe redirect after an active session', async () => {
    const redirectScreen = await render(
      <QueryClientProvider client={queryClient}>
        <UserAuthForm redirectTo='/settings' />
      </QueryClientProvider>
    )

    await userEvent.fill(
      redirectScreen.getByRole('textbox', { name: /Email/i }).last(),
      'a@b.com'
    )
    await userEvent.fill(
      redirectScreen.getByLabelText('Password').last(),
      'password'
    )
    await userEvent.click(
      redirectScreen.getByRole('button', { name: /Sign in/i }).last()
    )

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/settings',
        replace: true,
      })
    )
  })

  it('falls back to the home route for an unsafe redirect', async () => {
    const redirectScreen = await render(
      <QueryClientProvider client={queryClient}>
        <UserAuthForm redirectTo='https://external.example/path' />
      </QueryClientProvider>
    )

    await userEvent.fill(
      redirectScreen.getByRole('textbox', { name: /Email/i }).last(),
      'a@b.com'
    )
    await userEvent.fill(
      redirectScreen.getByLabelText('Password').last(),
      'password'
    )
    await userEvent.click(
      redirectScreen.getByRole('button', { name: /Sign in/i }).last()
    )

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    )
  })

  it('prevents duplicate submissions while the request is pending', async () => {
    let resolveSignIn: (value: unknown) => void = () => undefined
    signInMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve
        })
    )

    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'password')
    const form = (signInButton.element() as HTMLButtonElement).form
    if (!form) throw new Error('Sign-in button is not associated with a form')
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(submitEvent)
    form.dispatchEvent(submitEvent)

    await expect.element(signInButton).toBeDisabled()
    await vi.waitFor(() => expect(signInMock).toHaveBeenCalledOnce())

    resolveSignIn({ sessionStatus: 'ACTIVE', csrfToken: 'rotated-csrf-token' })
    await vi.waitFor(() => expect(signInButton).toBeEnabled())
  })

  it('maps backend validation errors to the form fields', async () => {
    signInMock.mockRejectedValue(
      new CoreApiError({
        message: 'Validation failed',
        status: 422,
        code: 'VALIDATION_FAILED',
        fieldErrors: {
          email: ['Use a valid work email.'],
          password: ['Password was rejected.'],
        },
        kind: 'http',
      })
    )

    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'password')
    await userEvent.click(signInButton)

    await expect
      .element(screen.getByText('Use a valid work email.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Password was rejected.'))
      .toBeInTheDocument()
  })

  it.each([
    [401, 'Invalid email or password.'],
    [403, 'Sign-in was blocked. Refresh the page and try again.'],
    [429, 'Too many sign-in attempts. Please wait a moment and try again.'],
    [503, 'The service is temporarily unavailable. Please try again later.'],
  ] as const)(
    'renders a truthful %s error message',
    async (status, message) => {
      signInMock.mockRejectedValue(
        new CoreApiError({
          message: 'backend message must not drive this UI',
          status,
          code: 'BACKEND_CODE',
          kind: status >= 500 ? 'server' : 'http',
        })
      )

      await userEvent.fill(emailInput, 'a@b.com')
      await userEvent.fill(passwordInput, 'password')
      await userEvent.click(signInButton)

      await expect.element(screen.getByText(message)).toBeInTheDocument()
      expect(navigate).not.toHaveBeenCalled()
    }
  )

  it('renders connectivity errors without navigating', async () => {
    signInMock.mockRejectedValue(
      new CoreApiError({
        message: 'Network Error',
        code: 'NETWORK_ERROR',
        kind: 'network',
      })
    )

    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'password')
    await userEvent.click(signInButton)

    await expect
      .element(
        screen.getByText(
          'Unable to connect to the service. Check your connection and try again.'
        )
      )
      .toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate for malformed successful responses', async () => {
    signInMock.mockRejectedValue(
      new CoreApiError({
        message: 'Malformed response',
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
      })
    )

    await userEvent.fill(emailInput, 'a@b.com')
    await userEvent.fill(passwordInput, 'password')
    await userEvent.click(signInButton)

    await expect
      .element(
        screen.getByText('Unable to sign in right now. Please try again.')
      )
      .toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })
})
