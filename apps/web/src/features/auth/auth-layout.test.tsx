import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { AuthLayout } from './auth-layout'

describe('AuthLayout', () => {
  const originalUrl = window.location.href
  const originalState: unknown = window.history.state

  afterEach(() => {
    window.history.replaceState(originalState, '', originalUrl)
  })

  it('does not mutate unrelated navigation fragments or history state', async () => {
    window.history.replaceState({ marker: 'preserved' }, '', '/sign-in#help')
    const screen = await render(
      <AuthLayout>
        <p>Sign in form</p>
      </AuthLayout>
    )

    await expect.element(screen.getByText('Sign in form')).toBeInTheDocument()
    expect(window.location.hash).toBe('#help')
    expect(window.history.state).toEqual({ marker: 'preserved' })
  })
})
