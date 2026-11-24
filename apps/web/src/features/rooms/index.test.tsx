import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { coreApi, CoreApiError } from '@/lib/core-api'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { meetingListQueryKey } from '@/features/meetings/data/meeting-cache'
import { RoomsPage } from './index'
import {
  normalizeRoomSearch,
  updateRoomSearch,
  type RoomDirectorySearch,
} from './room-directory-state'

const roomId = '11111111-1111-4111-8111-111111111111'
const room = {
  id: roomId,
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  status: 'ACTIVE' as const,
  notes: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}

function identity(role: 'ADMINISTRATOR' | 'EMPLOYEE' | 'DEPARTMENT_MANAGER') {
  return {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'room-operator@example.test',
    displayName: 'Room Operator',
    globalRole: role,
    accountStatus: 'ACTIVE' as const,
    primaryOrgUnitId: null,
    directoryManagementScope: { allUnits: false, unitIds: [] },
    session: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clientType: 'WEB' as const,
      createdAt: '2026-11-23T00:00:00Z',
      lastSeenAt: null,
      absoluteExpiresAt: '2027-11-23T00:00:00Z',
    },
  }
}

function roomListResponse(
  items: unknown[] = [room],
  pageNumber = 0,
  size = 20,
  totalElements = items.length
) {
  const totalPages = Math.ceil(totalElements / size)
  return {
    data: items,
    meta: {
      pagination: {
        page: pageNumber,
        size,
        totalElements,
        totalPages,
        hasNext: pageNumber + 1 < totalPages,
        hasPrevious: pageNumber > 0,
      },
    },
  }
}

function RoomsRouteHarness() {
  const search = useSearch({ strict: false }) as RoomDirectorySearch
  const navigate = useNavigate() as unknown as (options: {
    search:
      | RoomDirectorySearch
      | ((previous: RoomDirectorySearch) => RoomDirectorySearch)
    replace?: boolean
  }) => Promise<unknown>
  return (
    <RoomsPage
      search={search}
      onSearchChange={(patch, options) =>
        void navigate({
          search: (previous) => updateRoomSearch(previous, patch),
          replace: options?.replace,
        })
      }
    />
  )
}

function createRouterForRooms(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <SearchProvider>
          <ThemeProvider>
            <div className='flex min-w-0 flex-1 flex-col'>
              <Outlet />
            </div>
          </ThemeProvider>
        </SearchProvider>
      </SidebarProvider>
    ),
  })
  const roomsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/rooms',
    validateSearch: normalizeRoomSearch,
    component: RoomsRouteHarness,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([roomsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

async function renderRooms(
  actor = identity('ADMINISTRATOR'),
  initialEntry = '/rooms'
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  queryClient.setQueryData(currentUserQueryKey, actor)
  vi.spyOn(coreApi, 'get').mockResolvedValue(actor)
  const router = createRouterForRooms(initialEntry)
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { screen, queryClient, router }
}

function mockRoomReads({
  list = roomListResponse(),
  detail = room,
  etag = 'room-etag',
}: {
  list?: ReturnType<typeof roomListResponse>
  detail?: typeof room
  etag?: string | undefined
} = {}) {
  const listSpy = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url) => {
      if (url === '/rooms') return list
      throw new Error(`Unexpected Core API list request ${url}`)
    })
  const detailSpy = vi
    .spyOn(coreApi, 'getWithMetaAndEtag')
    .mockResolvedValue({ data: detail, meta: {}, etag })
  return { listSpy, detailSpy }
}

beforeEach(() => {
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.classList.remove('dark')
})

describe('Rooms Management', () => {
  it('uses URL-driven server search, status, sort, and pagination criteria', async () => {
    const { listSpy } = mockRoomReads({
      list: roomListResponse([{ ...room, status: 'INACTIVE' }], 1, 50, 51),
    })
    const { router, screen } = await renderRooms(
      identity('ADMINISTRATOR'),
      '/rooms?q=Board&status=INACTIVE&sort=name%2Cdesc&page=1&size=50'
    )
    await expect
      .element(screen.getByRole('cell', { name: 'Inactive' }))
      .toBeVisible()
    await expect
      .poll(() => listSpy.mock.calls.find(([url]) => url === '/rooms'))
      .toMatchObject([
        '/rooms',
        {
          params: {
            q: 'Board',
            status: 'INACTIVE',
            sort: 'name,desc',
            page: 1,
            size: 50,
          },
        },
      ])
    expect(router.state.location.search).toEqual({
      q: 'Board',
      status: 'INACTIVE',
      sort: 'name,desc',
      page: 1,
      size: 50,
    })
    expect(screen.getByRole('table')).toBeVisible()
  })

  it('forces active-only browsing and removes an incompatible inactive URL for non-admins', async () => {
    const { listSpy } = mockRoomReads()
    const { router, screen } = await renderRooms(
      identity('EMPLOYEE'),
      '/rooms?status=INACTIVE&page=3'
    )
    await expect.element(screen.getByText('Boardroom')).toBeVisible()
    await expect.poll(() => router.state.location.search).toEqual({})
    const request = listSpy.mock.calls.find(([url]) => url === '/rooms')
    expect(request?.[1]?.params).toMatchObject({ status: 'ACTIVE', page: 0 })
    expect(request?.[1]?.params.status).not.toBe('INACTIVE')
    await expect
      .element(screen.getByRole('button', { name: 'Add room' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Deactivate' }))
      .not.toBeInTheDocument()
  })

  it('initializes edits from the authoritative detail and submits its original ETag with a sparse patch', async () => {
    const authoritative = { ...room, name: 'Canonical Boardroom' }
    const { detailSpy } = mockRoomReads({ detail: authoritative })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...authoritative, name: 'Renamed Boardroom' },
        meta: {},
        etag: 'room-etag-next',
      })
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await expect.element(nameInput).toHaveValue('Canonical Boardroom')
    await userEvent.fill(nameInput, 'Renamed Boardroom')
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await vi.waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1))
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith(
      `/rooms/${roomId}`,
      { name: 'Renamed Boardroom' },
      { headers: { 'If-Match': 'room-etag' } }
    )
  })

  it('preserves unsaved edits on 412 and requires explicit review before restarting', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(roomListResponse())
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: room, meta: {}, etag: 'reviewed-etag' })
      .mockResolvedValueOnce({
        data: { ...room, name: 'Changed elsewhere' },
        meta: {},
        etag: 'latest-etag',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          status: 412,
          message: 'Stale room',
          kind: 'http',
        })
      )
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.fill(nameInput, 'My unsaved change')
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await expect
      .element(screen.getByText(/changed on the server/i))
      .toBeVisible()
    await expect.element(nameInput).toHaveValue('My unsaved change')
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest for review' })
    )
    await expect.element(screen.getByText('Changed elsewhere')).toBeVisible()
    await expect.element(nameInput).toHaveValue('My unsaved change')
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Discard my edits and restart from latest',
      })
    )
    await expect.element(nameInput).toHaveValue('Changed elsewhere')
    expect(detailSpy).toHaveBeenCalledTimes(2)
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('uses an accessible deactivation confirmation and the pre-confirmation ETag', async () => {
    const { detailSpy } = mockRoomReads({
      detail: room,
      etag: 'deactivation-snapshot',
    })
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: { ...room, status: 'INACTIVE' },
      meta: {},
      etag: 'deactivated-version',
    })
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate Boardroom' })
    )
    await expect
      .element(screen.getByRole('alertdialog', { name: /deactivate room/i }))
      .toBeVisible()
    await expect
      .element(
        screen
          .getByRole('alertdialog', { name: /deactivate room/i })
          .getByText('BOARD-1')
      )
      .toBeVisible()
    await expect
      .element(screen.getByText(/historical meeting references/i))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate room' })
    )
    await vi.waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(postSpy).toHaveBeenCalledWith(
      `/rooms/${roomId}/deactivate`,
      undefined,
      { headers: { 'If-Match': 'deactivation-snapshot' } }
    )
  })

  it('does not run confirmed-rejection cache synchronization and prevents duplicate submits', async () => {
    mockRoomReads()
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    let rejectDeactivate!: (error: Error) => void
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDeactivate = reject
        })
    )
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate Boardroom' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate room' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Deactivating…' }))
      .toBeDisabled()
    expect(postSpy).toHaveBeenCalledTimes(1)
    rejectDeactivate(
      new CoreApiError({
        status: 409,
        message: 'Business conflict',
        kind: 'http',
      })
    )
    await expect
      .element(screen.getByText(/current state or reservations conflict/i))
      .toBeVisible()
    expect(invalidate).not.toHaveBeenCalled()
    expect(meetingListQueryKey).toEqual(['meetings', 'list'])
  })

  it('keeps the table responsive and operable with keyboard at a narrow dark-mode viewport', async () => {
    const { listSpy } = mockRoomReads()
    await page.viewport(390, 844)
    document.documentElement.classList.add('dark')
    const { screen } = await renderRooms(identity('EMPLOYEE'))
    await expect
      .element(screen.getByRole('heading', { name: 'Meeting Rooms' }))
      .toBeVisible()
    await expect.element(screen.getByRole('table')).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth
    )
    const search = screen.getByRole('textbox', { name: 'Search rooms' })
    await userEvent.click(search)
    await userEvent.keyboard('Board')
    await expect.element(search).toHaveValue('Board')
    await expect
      .poll(() =>
        listSpy.mock.calls.some(
          ([url, config]) => url === '/rooms' && config?.params?.q === 'Board'
        )
      )
      .toBe(true)
  })
})
