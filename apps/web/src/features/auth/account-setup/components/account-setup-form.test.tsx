import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError } from '@/lib/core-api'
import { PasswordEstablishmentForm } from '../../account-flows/password-establishment-form'

describe('shared credential establishment form', () => {
  const submit = vi.fn<(password: string) => Promise<void>>()
  const complete = vi.fn()

  beforeEach(() => {
    submit.mockReset().mockResolvedValue(undefined)
    complete.mockClear()
  })

  async function renderForm() {
    return render(
      <PasswordEstablishmentForm
        kind='setup'
        onSubmit={submit}
        onCompleted={complete}
      />
    )
  }

  it('rejects short Unicode passwords and confirmation mismatches inline', async () => {
    const screen = await renderForm()
    const password = screen.getByLabelText('New password')
    const confirmation = screen.getByLabelText('Confirm password')
    const action = screen.getByRole('button', { name: 'Activate account' })

    await userEvent.fill(password, '🔒'.repeat(8))
    await userEvent.fill(confirmation, 'different')
    await userEvent.click(action)
    await expect
      .element(
        screen.getByText('Use 15–128 Unicode characters.', { exact: true })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText("Passwords don't match."))
      .toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  })

  it('preserves the exact password and accepts 128 supplementary code points', async () => {
    const screen = await renderForm()
    const password = ' ' + '🔒'.repeat(126) + ' '
    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Activate account' })
    )
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(submit).toHaveBeenCalledExactlyOnceWith(password)
    await expect.element(screen.getByLabelText('New password')).toHaveValue('')
  })

  it('maps a backend password rejection to the field and permits correction', async () => {
    submit.mockRejectedValueOnce(
      new CoreApiError({
        kind: 'http',
        status: 422,
        message: 'private detail',
        fieldErrors: { password: ['private field detail'] },
      })
    )
    const screen = await renderForm()
    const password = screen.getByLabelText('New password')
    const confirmation = screen.getByLabelText('Confirm password')
    const action = screen.getByRole('button', { name: 'Activate account' })
    await userEvent.fill(password, 'first private password')
    await userEvent.fill(confirmation, 'first private password')
    await userEvent.click(action)
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Choose a different password')
    await expect.element(password).toHaveAttribute('aria-invalid', 'true')
    expect(complete).not.toHaveBeenCalled()
    await userEvent.fill(password, 'corrected private password')
    await userEvent.fill(confirmation, 'corrected private password')
    await userEvent.click(action)
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403])(
    'rejects HTTP %i without completing setup',
    async (status) => {
      submit.mockRejectedValueOnce(
        new CoreApiError({ kind: 'http', status, message: 'private detail' })
      )
      const screen = await renderForm()
      const password = 'private activation password'
      await userEvent.fill(screen.getByLabelText('New password'), password)
      await userEvent.fill(screen.getByLabelText('Confirm password'), password)
      await userEvent.click(
        screen.getByRole('button', { name: 'Activate account' })
      )
      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent(/account request was blocked/i)
      await expect
        .element(screen.getByRole('alert'))
        .not.toHaveTextContent('private detail')
      expect(submit).toHaveBeenCalledOnce()
      expect(complete).not.toHaveBeenCalled()
    }
  )

  it('clears credentials when setup is unavailable', async () => {
    submit.mockRejectedValueOnce(
      new CoreApiError({ kind: 'http', status: 404, message: 'Not found' })
    )
    const screen = await renderForm()
    const password = 'private activation password'
    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Activate account' })
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/account flow is unavailable/i)
    await expect.element(screen.getByLabelText('New password')).toHaveValue('')
    await expect
      .element(screen.getByLabelText('Confirm password'))
      .toHaveValue('')
    await expect
      .element(screen.getByRole('button', { name: 'Activate account' }))
      .toBeDisabled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('prevents duplicate pending submissions and does not retry an uncertain mutation', async () => {
    let rejectRequest: (reason: unknown) => void = () => {}
    submit.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject
        })
    )
    const screen = await renderForm()
    const password = 'private password chosen'
    await userEvent.fill(screen.getByLabelText('New password'), password)
    await userEvent.fill(screen.getByLabelText('Confirm password'), password)
    await userEvent.click(
      screen.getByRole('button', { name: 'Activate account' })
    )
    await expect.element(screen.getByLabelText('New password')).toBeDisabled()
    const form = screen.getByLabelText('New password').element().closest('form')
    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    expect(submit).toHaveBeenCalledOnce()
    rejectRequest(
      new CoreApiError({ kind: 'network', message: 'lost response' })
    )
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/may already/i)
    await expect
      .element(screen.getByRole('button', { name: 'Activate account' }))
      .toBeDisabled()
    expect(complete).not.toHaveBeenCalled()
  })
})
