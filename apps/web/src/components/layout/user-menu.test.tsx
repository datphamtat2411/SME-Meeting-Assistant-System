import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { type UserPresentation } from './types'
import { UserMenu } from './user-menu'

const testUser: UserPresentation = {
  displayName: 'Ari Stone',
  email: 'ari@example.test',
  avatarUrl: undefined,
  initials: 'AS',
}

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => <UserMenu user={testUser} />,
  })
  const route = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    })
  const routeTree = rootRoute.addChildren([
    route('/'),
    route('/settings'),
    route('/settings/account'),
    route('/settings/notifications'),
    route('/sign-in'),
  ])

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('UserMenu', () => {
  it('renders identity fallback and preserves account navigation links', async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />)

    await expect
      .element(screen.getByText('AS', { exact: true }))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Open user menu' })
    )
    const menu = screen.getByRole('menu')

    await expect.element(screen.getByText('Ari Stone')).toBeInTheDocument()
    await expect
      .element(screen.getByText('ari@example.test'))
      .toBeInTheDocument()
    await expect
      .element(menu.getByRole('menuitem', { name: 'Profile' }))
      .toHaveAttribute('href', '/settings')
    await expect
      .element(menu.getByRole('menuitem', { name: 'Account' }))
      .toHaveAttribute('href', '/settings/account')
    await expect
      .element(menu.getByRole('menuitem', { name: 'Notifications' }))
      .toHaveAttribute('href', '/settings/notifications')
  })

  it('opens the existing destructive sign-out dialog from the shared menu', async () => {
    const screen = await render(<RouterProvider router={createTestRouter()} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Open user menu' })
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    await expect
      .element(screen.getByRole('alertdialog', { name: 'Sign out' }))
      .toBeInTheDocument()
  })

  it('does not invent a fixture identity when no canonical user is supplied', async () => {
    const screen = await render(<UserMenu />)

    await expect.element(screen.getByText('Nguyễn Lan')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Open user menu' }))
      .not.toBeInTheDocument()
  })
})
