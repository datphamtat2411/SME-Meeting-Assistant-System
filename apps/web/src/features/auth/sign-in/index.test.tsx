import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { SignIn } from './index'
import { SignIn2 } from './sign-in-2'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useSearch: () => ({ redirect: undefined }),
    Link: ({
      children,
      to,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
    }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})

describe('sign-in variants', () => {
  it('remove self-registration affordances while keeping the sign-in forms', async () => {
    const screen = await render(
      <>
        <SignIn />
        <SignIn2 />
      </>
    )

    await expect
      .element(screen.getByRole('button', { name: /^Sign in$/i }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/^Sign Up$/i))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText(/Don't have an account/i))
      .not.toBeInTheDocument()
  })
})
