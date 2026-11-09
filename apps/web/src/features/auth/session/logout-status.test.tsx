import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { LogoutStatus } from './logout-status'

describe('LogoutStatus', () => {
  it('explains an unconfirmed logout and exposes an accessible retry action', async () => {
    const retry = vi.fn()
    const screen = await render(
      <LogoutStatus state='uncertain' onRetry={retry} />
    )

    await expect
      .element(screen.getByRole('heading', { name: /could not be confirmed/i }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/server sign-out could not be confirmed/i))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /retry sign out/i }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows pending feedback without presenting sign-in controls as available', async () => {
    const screen = await render(
      <LogoutStatus state='pending' onRetry={vi.fn()} />
    )

    await expect
      .element(screen.getByRole('heading', { name: /signing you out/i }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: /retry sign out/i }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: /^sign in$/i }))
      .not.toBeInTheDocument()
  })
})
