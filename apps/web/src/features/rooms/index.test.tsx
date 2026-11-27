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
  const identityRead = vi
    .spyOn(coreApi, 'get')
    .mockImplementation(async (url) => {
      if (url === '/auth/me') return actor as never
      throw new Error(`Unexpected Core GET ${url}`)
    })
  const router = createRouterForRooms(initialEntry)
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { screen, queryClient, router, identityRead }
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

  it('synchronizes room and meeting projections after a confirmed metadata edit', async () => {
    const { listSpy } = mockRoomReads()
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockResolvedValue({
      data: { ...room, name: 'Updated boardroom' },
      meta: {},
      etag: 'updated-etag',
    })
    const { screen, queryClient } = await renderRooms()
    queryClient.setQueryDefaults(['meetings'], { gcTime: Infinity })
    queryClient.setQueryData(meetingListQueryKey, { meetings: [] })
    queryClient.setQueryData(['meetings', 'detail', 'test-meeting'], {
      id: 'test-meeting',
    })
    await expect.element(screen.getByText('Boardroom')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Updated boardroom'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    )
    await expect.element(screen.getByText('Boardroom')).toBeVisible()
    expect(listSpy.mock.calls.filter(([url]) => url === '/rooms')).toHaveLength(
      2
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail'],
    })
    expect(queryClient.getQueryState(meetingListQueryKey)?.isInvalidated).toBe(
      true
    )
    expect(
      queryClient.getQueryState(['meetings', 'detail', 'test-meeting'])
        ?.isInvalidated
    ).toBe(true)
  })

  it('reconciles a confirmed change after the verified authorization context changes', async () => {
    mockRoomReads()
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    let resolvePatch!: (value: {
      data: typeof room
      meta: Record<string, never>
      etag: string
    }) => void
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePatch = resolve
          })
      )
    const { screen, queryClient, identityRead } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Updated in flight'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))
    await expect
      .element(screen.getByRole('button', { name: 'Saving…' }))
      .toBeDisabled()

    identityRead.mockResolvedValue({
      ...identity('ADMINISTRATOR'),
      userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .not.toBeInTheDocument()
    resolvePatch({
      data: { ...room, name: 'Updated in flight' },
      meta: {},
      etag: 'updated-etag',
    })

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
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
    await expect
      .element(screen.getByRole('group').getByText('Changed elsewhere'))
      .toBeVisible()
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

  it('keeps an intended edit while adopting independent server metadata before a sparse retry', async () => {
    mockRoomReads()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: room, meta: {}, etag: 'original-etag' })
      .mockResolvedValueOnce({
        data: { ...room, capacity: 20 },
        meta: {},
        etag: 'latest-etag',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 412,
          message: 'Stale room',
          kind: 'http',
        })
      )
      .mockResolvedValueOnce({
        data: { ...room, name: 'Conference Room', capacity: 20 },
        meta: {},
        etag: 'updated-etag',
      })
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Conference Room'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest for review' })
    )
    await expect
      .element(screen.getByText(/independent server changes/i))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Keep intended changes and continue',
      })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('Conference Room')
    await expect
      .element(screen.getByRole('textbox', { name: 'Capacity' }))
      .toHaveValue('20')
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await vi.waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(2))
    expect(detailSpy).toHaveBeenCalledTimes(2)
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/rooms/${roomId}`,
      { name: 'Conference Room' },
      { headers: { 'If-Match': 'latest-etag' } }
    )
  })

  it('uses an accessible deactivation confirmation and the pre-confirmation ETag', async () => {
    const { detailSpy } = mockRoomReads({
      detail: room,
      etag: 'deactivation-snapshot',
    })
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
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
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail'],
    })
  })

  it('synchronizes room queries but not meeting projections after confirmed creation', async () => {
    let directoryRooms = [room]
    const listSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url) => {
        if (url !== '/rooms') throw new Error(`Unexpected list ${url}`)
        return roomListResponse(directoryRooms) as never
      })
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const createdRoom = {
      ...room,
      id: '33333333-3333-4333-8333-333333333333',
      code: 'NEW-BOARD',
      name: 'New Boardroom',
    }
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockImplementation(async () => {
      directoryRooms = [createdRoom]
      return {
        data: createdRoom,
        meta: {},
        etag: 'created-etag',
      } as never
    })
    const { screen, queryClient } = await renderRooms()
    queryClient.setQueryDefaults(['meetings'], { gcTime: Infinity })
    queryClient.setQueryData(meetingListQueryKey, { meetings: [] })
    queryClient.setQueryData(['meetings', 'detail', 'test-meeting'], {
      id: 'test-meeting',
    })
    await expect.element(screen.getByText('Boardroom')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Add room' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Room code' }),
      'NEW-BOARD'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Boardroom'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] })
    )
    await expect.element(screen.getByText('New Boardroom')).toBeVisible()
    expect(listSpy.mock.calls.filter(([url]) => url === '/rooms')).toHaveLength(
      2
    )
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: meetingListQueryKey,
    })
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail'],
    })
    expect(queryClient.getQueryState(meetingListQueryKey)?.isInvalidated).toBe(
      false
    )
    expect(
      queryClient.getQueryState(['meetings', 'detail', 'test-meeting'])
        ?.isInvalidated
    ).toBe(false)
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

  it('cancels obsolete search drafts across browser Back and Forward navigation', async () => {
    const { listSpy } = mockRoomReads()
    const { router, screen } = await renderRooms(
      identity('ADMINISTRATOR'),
      '/rooms?q=alpha'
    )
    const search = screen.getByRole('textbox', { name: 'Search rooms' })
    await expect.element(search).toHaveValue('alpha')
    await userEvent.fill(search, 'obsolete draft')

    await router.navigate({ search: { q: 'bravo' } as never })
    await expect.poll(() => router.state.location.search.q).toBe('bravo')
    await expect.element(search).toHaveValue('bravo')
    router.history.back()
    await expect.poll(() => router.state.location.search.q).toBe('alpha')
    await expect.element(search).toHaveValue('alpha')
    router.history.forward()
    await expect.poll(() => router.state.location.search.q).toBe('bravo')
    await expect.element(search).toHaveValue('bravo')
    await new Promise((resolve) => window.setTimeout(resolve, 450))

    expect(router.state.location.search.q).toBe('bravo')
    expect(
      listSpy.mock.calls.some(
        ([url, config]) =>
          url === '/rooms' && config?.params?.q === 'obsolete draft'
      )
    ).toBe(false)
  })

  it('preserves an open room draft during background identity refresh and pauses submission', async () => {
    mockRoomReads()
    const { queryClient, screen, identityRead } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await expect.element(nameInput).toHaveValue('Boardroom')
    await userEvent.fill(nameInput, 'Unsaved room draft')

    let resolveRefresh!: (value: unknown) => void
    identityRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        }) as never
    )
    const refresh = queryClient.invalidateQueries({
      queryKey: currentUserQueryKey,
    })
    await expect.element(nameInput).toHaveValue('Unsaved room draft')
    await expect
      .element(screen.getByRole('button', { name: 'Save room' }))
      .toBeDisabled()

    resolveRefresh(identity('ADMINISTRATOR'))
    await refresh
    await expect.element(nameInput).toHaveValue('Unsaved room draft')
    await expect
      .element(screen.getByRole('button', { name: 'Save room' }))
      .toBeEnabled()
  })

  it('invalidates a pending snapshot operation when authorization changes', async () => {
    mockRoomReads()
    let resolveDetail!: (value: {
      data: typeof room
      meta: Record<string, never>
      etag: string
    }) => void
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDetail = resolve
          })
      )
    const { queryClient, screen, identityRead } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    await expect
      .element(screen.getByRole('heading', { name: 'Loading current room' }))
      .toBeVisible()

    identityRead.mockResolvedValue(identity('EMPLOYEE'))
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })
    resolveDetail({ data: room, meta: {}, etag: 'late-etag' })

    await expect
      .element(screen.getByRole('button', { name: 'Add room' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .not.toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledTimes(1)
  })

  it('reports an exact existing room after an uncertain matching creation without retrying', async () => {
    const matchingRoom = {
      ...room,
      id: '33333333-3333-4333-8333-333333333333',
      code: 'NEW-BOARD',
      name: 'New Boardroom',
      location: null,
      capacity: null,
    }
    const listSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url !== '/rooms') throw new Error(`Unexpected list ${url}`)
        if (config?.params?.q === 'NEW-BOARD') {
          expect(config.params).toMatchObject({
            q: 'NEW-BOARD',
            page: 0,
            size: 100,
            sort: 'code,asc',
          })
          expect(config.params).not.toHaveProperty('status')
          return roomListResponse([matchingRoom], 0, 100, 1) as never
        }
        return roomListResponse() as never
      })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          status: 503,
          message: 'Service unavailable',
          kind: 'server',
        })
      )
    const { screen } = await renderRooms()
    await userEvent.click(screen.getByRole('button', { name: 'Add room' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Room code' }),
      'new-board'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Boardroom'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await expect
      .element(
        screen.getByText(
          /exact room code already exists and its metadata matches/i
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByText(/room code NEW-BOARD already exists/i))
      .toBeVisible()
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(
      listSpy.mock.calls.some(
        ([url, config]) =>
          url === '/rooms' &&
          config?.params?.q === 'NEW-BOARD' &&
          config.params.page === 0 &&
          config.params.size === 100
      )
    ).toBe(true)

    await expect
      .element(screen.getByRole('button', { name: 'Create room' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: 'Review creation draft' }))
      .not.toBeInTheDocument()
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('requires reviewing the preserved draft before retrying an uncertain creation not found by exact code', async () => {
    const listSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url !== '/rooms') throw new Error(`Unexpected list ${url}`)
        if (config?.params?.q === 'NEW-BOARD') {
          expect(config.params).toMatchObject({
            q: 'NEW-BOARD',
            page: 0,
            size: 100,
            sort: 'code,asc',
          })
          expect(config.params).not.toHaveProperty('status')
          return roomListResponse([room], 0, 100, 1) as never
        }
        return roomListResponse() as never
      })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          status: 503,
          message: 'Service unavailable',
          kind: 'server',
        })
      )
    const { screen } = await renderRooms()
    await userEvent.click(screen.getByRole('button', { name: 'Add room' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Room code' }),
      'new-board'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Boardroom'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await expect
      .element(screen.getByText(/no exact room code was found/i))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Create room' }))
      .toBeDisabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Review creation draft' })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Room code' }))
      .toHaveValue('new-board')
    await expect
      .element(screen.getByRole('button', { name: 'Create room' }))
      .toBeEnabled()
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(
      listSpy.mock.calls.some(
        ([url, config]) => url === '/rooms' && config?.params?.q === 'NEW-BOARD'
      )
    ).toBe(true)
  })

  it('retries a failed creation verification read without sending another creation request', async () => {
    let verificationAttempts = 0
    const listSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url !== '/rooms') throw new Error(`Unexpected list ${url}`)
        if (config?.params?.q === 'NEW-BOARD') {
          verificationAttempts += 1
          if (verificationAttempts === 1) {
            throw new CoreApiError({
              code: 'NETWORK_ERROR',
              message: 'Catalog unavailable',
              kind: 'network',
            })
          }
          return roomListResponse([room], 0, 100, 1) as never
        }
        return roomListResponse() as never
      })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          status: 503,
          message: 'Service unavailable',
          kind: 'server',
        })
      )
    const { screen } = await renderRooms()
    await userEvent.click(screen.getByRole('button', { name: 'Add room' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Room code' }),
      'new-board'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Boardroom'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await expect
      .element(screen.getByRole('button', { name: 'Retry verification' }))
      .toBeVisible()
    expect(createSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry verification' })
    )
    await expect
      .element(screen.getByText(/no exact room code was found/i))
      .toBeVisible()
    expect(verificationAttempts).toBe(2)
    expect(listSpy).toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves an uncertain edit draft and requires review before using a fresh ETag', async () => {
    mockRoomReads()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: room, meta: {}, etag: 'original-etag' })
      .mockResolvedValueOnce({
        data: { ...room, name: 'Renamed elsewhere' },
        meta: {},
        etag: 'latest-etag',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 503,
          message: 'Response interrupted',
          kind: 'server',
        })
      )
      .mockResolvedValueOnce({
        data: { ...room, name: 'My reviewed draft' },
        meta: {},
        etag: 'new-etag',
      })
    const { screen } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await expect.element(nameInput).toHaveValue('Boardroom')
    await userEvent.fill(nameInput, 'My reviewed draft')
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))

    await expect.element(screen.getByText(/field conflicts/i)).toBeVisible()
    await expect.element(nameInput).toHaveValue('My reviewed draft')
    expect(detailSpy).toHaveBeenCalledTimes(2)
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('radio', {
        name: /your intended value my reviewed draft/i,
      })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Resolve conflicts and continue' })
    )
    await expect.element(nameInput).toHaveValue('My reviewed draft')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Save room' }))
    await vi.waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(2))
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/rooms/${roomId}`,
      { name: 'My reviewed draft' },
      { headers: { 'If-Match': 'latest-etag' } }
    )
  })

  it('reconciles uncertain deactivation without attributing a verified inactive state to the request', async () => {
    mockRoomReads()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: room, meta: {}, etag: 'active-etag' })
      .mockResolvedValueOnce({
        data: { ...room, status: 'INACTIVE' },
        meta: {},
        etag: 'inactive-etag',
      })
    const deactivateSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          code: 'NETWORK_ERROR',
          message: 'Connection interrupted',
          kind: 'network',
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
      .element(screen.getByText(/latest server state is inactive/i))
      .toBeVisible()
    await expect
      .element(screen.getByText(/cannot determine whether this request/i))
      .toBeVisible()
    expect(detailSpy).toHaveBeenCalledTimes(2)
    expect(deactivateSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves an edit draft through transient identity verification failure and resumes after retry', async () => {
    mockRoomReads()
    const { queryClient, screen, identityRead } = await renderRooms()
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Boardroom' })
    )
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.fill(nameInput, 'Draft during verification failure')

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(currentUserQueryKey)?.fetchStatus).toBe(
        'idle'
      )
    )
    identityRead.mockRejectedValueOnce(
      new CoreApiError({
        code: 'NETWORK_ERROR',
        message: 'Identity lookup unavailable',
        kind: 'network',
      })
    )
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })

    await expect
      .element(screen.getByRole('dialog').getByText(/could not be verified/i))
      .toBeVisible()
    await expect
      .element(nameInput)
      .toHaveValue('Draft during verification failure')
    await expect
      .element(screen.getByRole('button', { name: 'Save room' }))
      .toBeDisabled()

    identityRead.mockResolvedValue(identity('ADMINISTRATOR'))
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry verification' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Save room' }))
      .toBeEnabled()
    await expect
      .element(nameInput)
      .toHaveValue('Draft during verification failure')
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
