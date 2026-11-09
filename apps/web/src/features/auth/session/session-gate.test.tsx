import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SessionGate } from './session-gate'

describe('SessionGate', () => {
  it('renders a neutral pending state without authenticated shell content', async () => {
    const screen = await render(<SessionGate state='pending' />)

    await expect.element(screen.getByText('Checking your session')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
      .not.toBeInTheDocument()
  })

  it('renders a distinct denied state', async () => {
    const screen = await render(<SessionGate state='denied' />)

    await expect.element(screen.getByText('Access denied')).toBeInTheDocument()
    await expect
      .element(screen.getByText(/do not have permission/i))
      .toBeInTheDocument()
  })

  it('renders a retryable unavailable state and invokes retry accessibly', async () => {
    const retry = vi.fn()
    const screen = await render(
      <SessionGate state='unavailable' onRetry={retry} />
    )

    await expect
      .element(screen.getByText('Session temporarily unavailable'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
  })
})
