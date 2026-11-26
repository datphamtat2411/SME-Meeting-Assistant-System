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
