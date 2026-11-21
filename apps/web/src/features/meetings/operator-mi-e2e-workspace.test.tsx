import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { UserPresentationProvider } from '@/components/layout/data/user-presentation'
import { OperatorMiE2eWorkspace } from './operator-mi-e2e-workspace'

const workflowMocks = vi.hoisted(() => ({
  verifyOperatorSession: vi.fn(),
  createSyntheticMeeting: vi.fn(),
}))

vi.mock('./data/operator-mi-e2e-workflow', async () => {
  const actual = await vi.importActual<
    typeof import('./data/operator-mi-e2e-workflow')
  >('./data/operator-mi-e2e-workflow')
  return {
    ...actual,
    verifyOperatorSession: workflowMocks.verifyOperatorSession,
    createSyntheticMeeting: workflowMocks.createSyntheticMeeting,
  }
})

const user = {
  userId: '46a30219-3c9f-498d-94fa-d6558f200714',
  email: 'e2e-04@example.invalid',
  displayName: 'E2E-04 Local Test',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '56b7d0a2-46c2-4f9b-bf2e-2e6f4f2d8f31',
    clientType: 'WEB' as const,
    createdAt: '2026-11-21T00:00:00Z',
    lastSeenAt: '2026-11-21T00:00:00Z',
    absoluteExpiresAt: '2026-11-22T00:00:00Z',
  },
}

const meeting = {
  id: 'meeting-1',
  title: 'Cuộc họp MI tiếng Việt',
  description: 'Synthetic bounded Vietnamese MI meeting.',
  organizerUserId: user.userId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: user.userId,
  createdAt: '2026-11-21T00:00:00Z',
  updatedAt: '2026-11-21T00:00:00Z',
}

const presentationUser = {
  displayName: user.displayName,
  email: user.email,
  initials: 'ET',
}

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SearchProvider>
          <UserPresentationProvider user={presentationUser}>
            <SidebarProvider>
              <OperatorMiE2eWorkspace />
            </SidebarProvider>
          </UserPresentationProvider>
        </SearchProvider>
      </ThemeProvider>
    ),
  })
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('OperatorMiE2eWorkspace', () => {
  beforeEach(() => {
    workflowMocks.verifyOperatorSession.mockReset()
    workflowMocks.createSyntheticMeeting.mockReset()
  })

  it('requires session verification and an explicit creation approval before one meeting request', async () => {
    workflowMocks.verifyOperatorSession.mockResolvedValue({ user })
    workflowMocks.createSyntheticMeeting.mockResolvedValue({
      session: { user },
      meeting: { meeting, etag: '"meeting-1-1' },
      detail: { meeting, etag: '"meeting-1-1' },
      organizerVerified: true,
    })

    const screen = await render(<RouterProvider router={createTestRouter()} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Verify Web session' })
    )
    await expect
      .element(screen.getByText('E2E-04 Local Test'))
      .toBeInTheDocument()
    expect(workflowMocks.verifyOperatorSession).toHaveBeenCalledWith(
      '46a30219-3c9f-498d-94fa-d6558f200714'
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Create exactly one synthetic meeting',
      })
    )
    expect(workflowMocks.createSyntheticMeeting).not.toHaveBeenCalled()
    await expect
      .element(
        screen.getByRole('alertdialog', { name: 'Approve meeting creation' })
      )
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'I approve meeting creation' })
    )
    await expect
      .element(screen.getByText('Organizer verified'))
      .toBeInTheDocument()
    expect(workflowMocks.createSyntheticMeeting).toHaveBeenCalledTimes(1)
  })
})
