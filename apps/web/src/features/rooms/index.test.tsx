import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'
import { RoomsPage } from './index'

const room = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  status: 'ACTIVE' as const,
  notes: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const admin = {
  userId: 'admin-1',
  email: 'admin@example.com',
  displayName: 'Room Admin',
  globalRole: 'ADMINISTRATOR',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: true, unitIds: [] },
  session: {
    id: 'session-1',
    clientType: 'WEB',
    createdAt: '2026-09-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2026-09-02T00:00:00Z',
  },
}

function createRouterForRooms() {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <SearchProvider>
          <ThemeProvider>
            <Outlet />
          </ThemeProvider>
        </SearchProvider>
      </SidebarProvider>
    ),
  })
  const roomsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/rooms',
    component: RoomsPage,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([roomsRoute]),
    history: createMemoryHistory({ initialEntries: ['/rooms'] }),
  })
}

async function renderRoomsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(currentUserQueryKey, admin)
  const router = createRouterForRooms()
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { screen: view, queryClient }
}

function mockRoomReads() {
  vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
    data: [room],
    meta: {
      pagination: {
        page: 0,
        size: 10,
        totalElements: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      },
    },
  })
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
    data: room,
    meta: {},
    etag: 'room-etag',
  })
}

describe('RoomsPage cache coherence', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('refreshes room and canonical meeting-list projections after confirmed metadata edits', async () => {
    mockRoomReads()
    vi.spyOn(coreApi, 'patch').mockResolvedValue({
      ...room,
      name: 'Updated Boardroom',
      location: 'Floor 2',
    })
    const { screen, queryClient } = await renderRoomsPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Updated Boardroom'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Location' }),
      'Floor 2'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['rooms'] })
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: meetingListQueryKey,
      })
    })
  })

  it('does not invalidate display caches when a room metadata mutation fails', async () => {
    mockRoomReads()
    const patchSpy = vi
      .spyOn(coreApi, 'patch')
      .mockRejectedValue(new Error('Room update rejected'))
    const { screen, queryClient } = await renderRoomsPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Unconfirmed name'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))
    await expect.poll(() => patchSpy).toHaveBeenCalledTimes(1)

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('invalidates only room queries after room creation', async () => {
    mockRoomReads()
    vi.spyOn(coreApi, 'post').mockResolvedValue(room)
    const { screen, queryClient } = await renderRoomsPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Add room' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Room code' }),
      'NEW-1'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Room'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    )
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
  })

  it('refreshes meeting-list room projections after confirmed deactivation', async () => {
    mockRoomReads()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      ...room,
      status: 'INACTIVE',
    })
    const { screen, queryClient } = await renderRoomsPage()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['rooms'] })
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: meetingListQueryKey,
      })
    })
  })
})
