import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { ForgotPasswordForm } from './forgot-password-form'

describe('ForgotPasswordForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('requires an organization email before enabling recovery submission', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(undefined as never)
    const screen = await render(<ForgotPasswordForm />)
    const email = screen.getByRole('textbox', { name: 'Organization email' })
    const submit = screen.getByRole('button', { name: 'Send recovery link' })

    await expect.element(email).toHaveValue('')
    await expect.element(submit).toBeDisabled()
    expect(post).not.toHaveBeenCalled()

    await userEvent.fill(email, 'employee@example.com')
    await expect.element(submit).toBeEnabled()
    expect(post).not.toHaveBeenCalled()
  })

  it('submits to password recovery and shows the neutral account-existence acknowledgement', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(undefined as never)
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
      .toHaveTextContent(/If an eligible account exists for that email/i)
    expect(post).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledWith('/auth/password-recovery', {
      email: 'employee@example.com',
    })
    await expect
      .element(screen.getByRole('textbox', { name: 'Organization email' }))
      .not.toBeInTheDocument()
  })

  it('makes an unavailable deployment explicit and prevents repeated submission', async () => {
    const post = vi.spyOn(coreApi, 'post').mockRejectedValue(
      new CoreApiError({
        message: 'Not found',
        status: 404,
        code: 'RESOURCE_NOT_FOUND',
        kind: 'http',
      })
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
      .toHaveTextContent(/recovery endpoint is unavailable/i)
    await expect
      .element(screen.getByRole('button', { name: 'Send recovery link' }))
      .toBeDisabled()
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument()
    expect(post).toHaveBeenCalledOnce()
  })

  it('allows a retry after a transient server failure without falsely reporting success', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'Service temporarily unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          kind: 'server',
        })
      )
      .mockResolvedValueOnce(undefined as never)
    const screen = await render(<ForgotPasswordForm />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Organization email' }),
      'employee@example.com'
    )
    const submit = screen.getByRole('button', { name: 'Send recovery link' })

    await userEvent.click(submit)
    await expect.element(submit).toBeEnabled()
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument()
    expect(post).toHaveBeenCalledOnce()

    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/password reset instructions will be sent/i)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenNthCalledWith(2, '/auth/password-recovery', {
      email: 'employee@example.com',
    })
  })
})
