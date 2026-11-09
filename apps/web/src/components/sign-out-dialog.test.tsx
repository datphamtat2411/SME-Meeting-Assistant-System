import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SignOutDialog } from './sign-out-dialog'

const navigate = vi.fn()
const lifecycle = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'pending' | 'uncertain' | 'confirmed',
  begin: vi.fn(),
}))

const MOCK_HREF = 'https://app.test/dashboard?tab=1'

vi.mock('@/features/auth/session/logout-status', () => ({
  useAuthLifecycleState: () => lifecycle.state,
}))

vi.mock('@/features/auth/session/auth-lifecycle', () => ({
  beginAuthLifecycleLogout: lifecycle.begin,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useLocation: () => ({ href: MOCK_HREF }),
  }
})

describe('SignOutDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lifecycle.state = 'idle'
    lifecycle.begin.mockImplementation(
      ({
        redirect,
        navigate: navigateAway,
      }: {
        redirect?: string
        navigate?: (redirect?: string) => void
      }) => {
        navigateAway?.(redirect)
        return Promise.resolve({ state: 'confirmed' })
      }
    )
  })

  it('starts one lifecycle operation and navigates into containment', async () => {
    const { getByRole } = await render(
      <SignOutDialog open onOpenChange={vi.fn()} />
    )

    await userEvent.click(getByRole('button', { name: /^Sign out$/i }))

    expect(lifecycle.begin).toHaveBeenCalledOnce()
    expect(lifecycle.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect: MOCK_HREF,
        navigate: expect.any(Function),
      })
    )
    expect(navigate).toHaveBeenCalledWith({
      to: '/sign-in',
      search: { redirect: MOCK_HREF },
      replace: true,
    })
  })

  it('does not call reset or navigate when Cancel is clicked', async () => {
    const { getByRole } = await render(
      <SignOutDialog open onOpenChange={vi.fn()} />
    )

    await userEvent.click(getByRole('button', { name: /^Cancel$/i }))

    expect(lifecycle.begin).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('disables confirmation while logout is pending', async () => {
    lifecycle.state = 'pending'

    const { getByRole } = await render(
      <SignOutDialog open onOpenChange={vi.fn()} />
    )

    await expect
      .element(getByRole('button', { name: /^Signing out/i }))
      .toBeDisabled()
    expect(lifecycle.begin).not.toHaveBeenCalled()
  })
})
