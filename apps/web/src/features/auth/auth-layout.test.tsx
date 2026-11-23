import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { AuthLayout } from './auth-layout'

describe('AuthLayout', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/account-setup#token=one-time-capability')
  })

  afterEach(() => {
    window.history.pushState({}, '', '/sign-in')
  })

  it('removes callback capability fragments before the auth page paints', async () => {
    const screen = await render(
      <AuthLayout>
        <p>Activation form</p>
      </AuthLayout>
    )

    await expect
      .element(screen.getByText('Activation form'))
      .toBeInTheDocument()
    expect(window.location.pathname).toBe('/account-setup')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('one-time-capability')
  })
})
