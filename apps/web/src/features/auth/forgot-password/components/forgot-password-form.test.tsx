import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { ForgotPasswordForm } from './forgot-password-form'

describe('ForgotPasswordForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('validates email inline before sending recovery requests', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue({ message: 'Acknowledged' })
    const screen = await render(<ForgotPasswordForm />)
    const email = screen.getByRole('textbox', { name: 'Organization email' })
    const submit = screen.getByRole('button', { name: 'Send recovery link' })

    await expect.element(submit).toBeDisabled()
    await userEvent.fill(email, 'not-an-email')
    await userEvent.click(submit)
    await expect
      .element(screen.getByText('Enter a valid email address.'))
      .toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('uses a neutral acknowledgement and allows a different email', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue({ message: 'Acknowledged' })
    const screen = await render(<ForgotPasswordForm />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Organization email' }),
      'employee@example.com'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send recovery link' })
    )

    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/If an eligible account exists/i)
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/auth/password-recovery',
      { email: 'employee@example.com' },
      { timeout: 30_000 }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Use a different email' })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Organization email' }))
      .toHaveValue('')
  })

  it('makes an unavailable deployment explicit', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({ message: 'Not found', status: 404, kind: 'http' })
      )
      .mockResolvedValueOnce({ message: 'Acknowledged' })
    const screen = await render(<ForgotPasswordForm />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Organization email' }),
      'employee@example.com'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send recovery link' })
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/recovery is unavailable/i)
    await expect
      .element(screen.getByRole('button', { name: 'Try again' }))
      .toBeEnabled()
    expect(post).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/If an eligible account exists/i)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403])('presents a safe rejection for HTTP %i', async (status) => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ kind: 'http', status, message: 'private detail' })
      )
    const screen = await render(<ForgotPasswordForm />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Organization email' }),
      'employee@example.com'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send recovery link' })
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/recovery request was blocked/i)
    await expect
      .element(screen.getByRole('alert'))
      .not.toHaveTextContent('private detail')
    expect(post).toHaveBeenCalledOnce()
  })

  it('maps backend email validation to the field without exposing details', async () => {
    vi.spyOn(coreApi, 'post').mockRejectedValue(
      new CoreApiError({
        kind: 'http',
        status: 422,
        message: 'private detail',
        fieldErrors: { email: ['private field detail'] },
      })
    )
    const screen = await render(<ForgotPasswordForm />)
    const email = screen.getByRole('textbox', { name: 'Organization email' })
    await userEvent.fill(email, 'employee@example.com')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send recovery link' })
    )
    await expect
      .element(screen.getByText('Check the email address and try again.'))
      .toBeVisible()
    await expect.element(email).toHaveAttribute('aria-invalid', 'true')
    await expect
      .element(screen.getByRole('alert'))
      .not.toHaveTextContent('private field detail')
  })

  it('blocks repeated submits during Retry-After and releases without replay', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({
          kind: 'http',
          status: 429,
          message: 'throttled',
          retryAfter: '2',
        })
      )
      .mockResolvedValueOnce({ message: 'Acknowledged' })
    const screen = await render(<ForgotPasswordForm />)
    const email = screen.getByRole('textbox', { name: 'Organization email' })
    const submit = screen.getByRole('button', { name: 'Send recovery link' })
    await userEvent.fill(email, 'employee@example.com')
    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/too many requests/i)
    await expect.element(submit).toBeDisabled()
    const form = email.element().closest('form')
    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await vi.waitFor(
      () => expect(submit.element().hasAttribute('disabled')).toBe(false),
      { timeout: 3500 }
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('You can try again now.')
    expect(post).toHaveBeenCalledOnce()
    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/If an eligible account exists/i)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('reports an uncertain outcome and permits only an explicit recovery retry', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'private transport detail',
          kind: 'network',
        })
      )
      .mockResolvedValueOnce({ message: 'Acknowledged' })
    const screen = await render(<ForgotPasswordForm />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Organization email' }),
      'employee@example.com'
    )
    const submit = screen.getByRole('button', { name: 'Send recovery link' })
    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/may have been processed/i)
    await expect
      .element(screen.getByRole('alert'))
      .not.toHaveTextContent(/private transport detail/)
    expect(post).toHaveBeenCalledOnce()
    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/If an eligible account exists/i)
    expect(post).toHaveBeenCalledTimes(2)
  })
})
