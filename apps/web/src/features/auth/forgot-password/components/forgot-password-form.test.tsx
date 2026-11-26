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
    const post = vi.spyOn(coreApi, 'post').mockRejectedValue(
      new CoreApiError({ message: 'Not found', status: 404, kind: 'http' })
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
      .toHaveTextContent(/recovery is unavailable/i)
    await expect
      .element(screen.getByRole('button', { name: 'Send recovery link' }))
      .toBeDisabled()
    expect(post).toHaveBeenCalledOnce()
  })

  it('reports an uncertain outcome and permits only an explicit recovery retry', async () => {
    const post = vi.spyOn(coreApi, 'post')
      .mockRejectedValueOnce(new CoreApiError({ message: 'private transport detail', kind: 'network' }))
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
