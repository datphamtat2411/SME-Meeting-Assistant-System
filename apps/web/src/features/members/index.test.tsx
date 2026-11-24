import { useEffect } from 'react'
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
  useRouterState,
} from '@tanstack/react-router'
import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { MembersPage } from './index'
import {
  isMemberSearchCanonical,
  normalizeMemberSearch,
  updateMemberSearch,
  type MemberDirectorySearch,
} from './member-directory-state'

const unitId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'

function identity(
  role: 'ADMINISTRATOR' | 'DEPARTMENT_MANAGER' | 'EMPLOYEE',
  unitIds: string[] = [unitId]
) {
  return {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'operator@example.test',
    displayName: 'Directory Operator',
    globalRole: role,
    accountStatus: 'ACTIVE' as const,
    primaryOrgUnitId: null,
    directoryManagementScope: {
      allUnits: role === 'ADMINISTRATOR',
      unitIds: role === 'ADMINISTRATOR' ? [] : unitIds,
    },
    session: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clientType: 'WEB' as const,
      createdAt: '2026-11-23T00:00:00Z',
      lastSeenAt: null,
      absoluteExpiresAt: '2027-11-23T00:00:00Z',
    },
  }
}

const member = {
  id: memberId,
  email: 'lee@example.test',
  displayName: 'Lee Member',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: unitId,
  managerScopeUnitIds: [],
  createdAt: '2026-11-23T00:00:00Z',
  updatedAt: '2026-11-23T00:00:00Z',
}
const unit = {
  id: unitId,
  code: 'OPS',
  name: 'Operations',
  parentId: null,
  status: 'ACTIVE',
}

function listResponse(
  items: unknown[] = [member],
  page = 0,
  size = 20,
  totalElements = items.length
) {
  const totalPages = Math.ceil(totalElements / size)
  return {
    data: items,
    meta: {
      pagination: {
        page,
        size,
        totalElements,
        totalPages,
        hasNext: page + 1 < totalPages,
        hasPrevious: page > 0,
      },
    },
  }
}

function MembersRouteHarness() {
  const search = useSearch({ strict: false }) as MemberDirectorySearch
  const rawSearch = useRouterState({
    select: (routerState) => routerState.location.search,
  })
  const navigate = useNavigate() as unknown as (options: {
    search:
      | MemberDirectorySearch
      | ((previous: MemberDirectorySearch) => MemberDirectorySearch)
    replace?: boolean
  }) => Promise<unknown>
  useEffect(() => {
    if (isMemberSearchCanonical(rawSearch)) return
    void navigate({
      search: normalizeMemberSearch(rawSearch),
      replace: true,
    })
  }, [navigate, rawSearch])
  return (
    <MembersPage
      search={search}
      onSearchChange={(patch, options) =>
        void navigate({
          search: (previous) => updateMemberSearch(previous, patch),
          replace: options?.replace,
        })
      }
    />
  )
}

function createMembersRouter(initialEntry = '/members') {
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
  const membersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/members',
    validateSearch: normalizeMemberSearch,
    component: MembersRouteHarness,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([membersRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

async function renderMembers(
  actor = identity('ADMINISTRATOR'),
  initialEntry = '/members'
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
  const router = createMembersRouter(initialEntry)
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { screen, queryClient, router, identityRead }
}

function mockDirectory({
  directory = listResponse(),
  units = listResponse([unit], 0, 100),
  unitsError,
}: {
  directory?: ReturnType<typeof listResponse>
  units?: ReturnType<typeof listResponse>
  unitsError?: Error
} = {}) {
  return vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
    if (url === '/users') return directory
    if (url === '/organizational-units') {
      if (unitsError) throw unitsError
      return units
    }
    throw new Error(`Unexpected Core API directory request ${url}`)
  })
}

beforeEach(() => {
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.classList.remove('dark')
})

describe('Members directory', () => {
  it('uses URL criteria for server filtering and displays the develop-baseline identity presentation', async () => {
    const getSpy = mockDirectory()
    const { router, screen } = await renderMembers(
      identity('ADMINISTRATOR'),
      `/members?q=Lee&role=EMPLOYEE&status=ACTIVE&orgUnitId=${unitId}&page=0&size=20`
    )

    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await expect.element(screen.getByText('lee@example.test')).toBeVisible()
    await expect
      .element(screen.getByRole('table').getByText('Operations'))
      .toBeVisible()
    await expect
      .element(screen.getByRole('cell', { name: 'Employee' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('cell', { name: 'Active' }))
      .toBeVisible()
    await expect
      .poll(() => getSpy.mock.calls.find(([url]) => url === '/users'))
      .toMatchObject([
        '/users',
        {
          params: {
            q: 'Lee',
            role: 'EMPLOYEE',
            status: 'ACTIVE',
            orgUnitId: unitId,
            page: 0,
            size: 20,
          },
        },
      ])
    expect(router.state.location.search).toEqual({
      q: 'Lee',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      orgUnitId: unitId,
    })
    expect(screen.getByRole('table')).toBeVisible()
  })

  it('does not request protected directories for employees or managers with no grants', async () => {
    const getSpy = vi.spyOn(coreApi, 'getWithMeta')
    const employee = await renderMembers(identity('EMPLOYEE'))
    await expect
      .element(
        employee.screen.getByText(
          'Member directory access requires an authorized management scope.'
        )
      )
      .toBeVisible()
    expect(getSpy).not.toHaveBeenCalled()

    employee.queryClient.clear()
    const manager = await renderMembers(
      identity('DEPARTMENT_MANAGER', []),
      '/members'
    )
    await expect
      .element(
        manager.screen.getByText(
          'No organizational units are granted for member management.'
        )
      )
      .toBeVisible()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('keeps valid member rows usable and shows unresolved IDs when unit lookup fails', async () => {
    mockDirectory({ unitsError: new Error('Organization lookup unavailable') })
    const { screen } = await renderMembers()
    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await expect
      .element(
        screen.getByText(/Organizational unit names could not be loaded/)
      )
      .toBeVisible()
    await expect
      .element(screen.getByText(/Organizational unit lookup failed/))
      .toBeVisible()
    await expect.element(screen.getByText(unitId)).toBeVisible()
  })

  it('strips manager-incompatible URL filters before requesting and debounces search', async () => {
    const getSpy = mockDirectory()
    const manager = identity('DEPARTMENT_MANAGER')
    const { router, screen } = await renderMembers(
      manager,
      `/members?role=ADMINISTRATOR&orgUnitId=33333333-3333-4333-8333-333333333333&page=4`
    )
    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await expect.poll(() => router.state.location.search).toEqual({})
    const memberCall = getSpy.mock.calls.find(([url]) => url === '/users')
    expect(memberCall?.[1]).toMatchObject({
      params: { role: 'EMPLOYEE', page: 0, size: 20 },
    })
    expect(memberCall?.[1]?.params).not.toHaveProperty('orgUnitId')

    const searchInput = screen.getByRole('textbox', { name: 'Search members' })
    await userEvent.fill(searchInput, 'Lee Park')
    await expect
      .poll(() => router.state.location.search.q, { timeout: 1500 })
      .toBe('Lee Park')
    expect(getSpy.mock.calls.filter(([url]) => url === '/users').length).toBe(2)
  })

  it('cancels a pending search draft when browser navigation restores prior criteria', async () => {
    const getSpy = mockDirectory()
    const { router, screen } = await renderMembers(
      identity('ADMINISTRATOR'),
      '/members?q=alpha'
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Search members' }))
      .toHaveValue('alpha')

    const search = screen.getByRole('textbox', { name: 'Search members' })
    await userEvent.fill(search, 'obsolete draft')
    await router.navigate({
      search: { q: 'bravo' } as never,
    })
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
      getSpy.mock.calls.some(
        ([url, config]) =>
          url === '/users' && config?.params?.q === 'obsolete draft'
      )
    ).toBe(false)
  })

  it('keeps an open administration draft during background identity refresh and pauses submission', async () => {
    mockDirectory()
    const { queryClient, screen, identityRead } = await renderMembers()
    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.fill(name, 'Unsaved member draft')

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

    await expect
      .element(screen.getByRole('dialog', { name: 'Create account' }))
      .toBeVisible()
    await expect.element(name).toHaveValue('Unsaved member draft')
    await expect
      .element(screen.getByRole('button', { name: 'Save member' }))
      .toBeDisabled()

    resolveRefresh(identity('ADMINISTRATOR'))
    await refresh
    await expect.element(name).toHaveValue('Unsaved member draft')
    await expect
      .element(screen.getByRole('button', { name: 'Save member' }))
      .toBeEnabled()
  })

  it('removes a protected member draft when the verified actor changes', async () => {
    mockDirectory()
    const { queryClient, screen, identityRead } = await renderMembers()
    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Private draft'
    )

    const replacement = {
      ...identity('ADMINISTRATOR'),
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }
    identityRead.mockResolvedValue(replacement)
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })

    await expect
      .element(screen.getByText('Private draft'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('dialog', { name: 'Create account' }))
      .not.toBeInTheDocument()
  })

  it('creates a pending account with the canonical administrator payload', async () => {
    mockDirectory()
    const created = {
      ...member,
      id: '33333333-3333-4333-8333-333333333333',
      email: 'new.person@example.test',
      displayName: 'New Person',
      accountStatus: 'PENDING_SETUP',
    }
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: created, meta: {}, etag: 'W/"v-1"' })
    const { screen } = await renderMembers()

    await expect.element(screen.getByText('Lee Member')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'New Person'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Email' }),
      'New.Person@Example.Test'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => createSpy.mock.calls.length).toBe(1)
    expect(createSpy).toHaveBeenCalledWith('/users', {
      email: 'new.person@example.test',
      displayName: 'New Person',
      globalRole: 'EMPLOYEE',
    })
    await expect
      .element(screen.getByRole('dialog', { name: 'Create account' }))
      .not.toBeInTheDocument()
  })

  it('edits from one authoritative snapshot and sends its ETag without refetching at submit', async () => {
    mockDirectory()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: member, meta: {}, etag: 'W/"v-7"' })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...member, displayName: 'Renamed Member' },
        meta: {},
        etag: 'W/"v-8"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .toBeVisible()
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Renamed Member'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith(
      `/users/${memberId}`,
      { displayName: 'Renamed Member' },
      { headers: { 'If-Match': 'W/"v-7"' } }
    )
  })

  it('requires an authoritative snapshot before confirming lifecycle changes', async () => {
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: member,
      meta: {},
      etag: 'W/"v-9"',
    })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...member, accountStatus: 'INACTIVE' },
        meta: {},
        etag: 'W/"v-10"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await expect
      .element(
        screen.getByRole('alertdialog', { name: 'Deactivate member account?' })
      )
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate account' })
    )

    await expect.poll(() => lifecycleSpy.mock.calls.length).toBe(1)
    expect(lifecycleSpy).toHaveBeenCalledWith(
      `/users/${memberId}/deactivate`,
      undefined,
      { headers: { 'If-Match': 'W/"v-9"' } }
    )
  })

  it('keeps the directory usable at a narrow viewport and in dark mode with keyboard controls', async () => {
    const getSpy = mockDirectory()
    await page.viewport(390, 844)
    document.documentElement.classList.add('dark')
    const { screen } = await renderMembers()
    await expect
      .element(screen.getByRole('heading', { name: 'Members' }))
      .toBeVisible()
    await expect.element(screen.getByRole('table')).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth
    )
    const search = screen.getByRole('textbox', { name: 'Search members' })
    await userEvent.click(search)
    await userEvent.keyboard('Lee')
    await expect.element(search).toHaveValue('Lee')
    await expect
      .poll(() =>
        getSpy.mock.calls.some(
          ([url, config]) => url === '/users' && config?.params?.q === 'Lee'
        )
      )
      .toBe(true)
  })
})
