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
import { CoreApiError, coreApi } from '@/lib/core-api'
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
const productUnit = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'PROD',
  name: 'Product',
  parentId: null,
  status: 'ACTIVE',
}

function uncertainMutationError() {
  return new CoreApiError({
    message: 'The connection ended before the outcome was confirmed.',
    code: 'NETWORK_ERROR',
    kind: 'network',
  })
}

function staleMutationError() {
  return new CoreApiError({
    message: 'The member changed.',
    code: 'PRECONDITION_FAILED',
    status: 412,
    kind: 'http',
  })
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

  it.each([
    ['matching metadata', 'New Person', /matching metadata/i],
    ['conflicting metadata', 'Different Person', /different metadata/i],
  ])(
    'keeps an uncertain creation draft closed when an authorized account with %s is found',
    async (_, existingName, metadataMessage) => {
      const existing = {
        ...member,
        email: 'new.person@example.test',
        displayName: existingName,
        primaryOrgUnitId: null,
        accountStatus: 'PENDING_SETUP',
      }
      const getSpy = vi
        .spyOn(coreApi, 'getWithMeta')
        .mockImplementation(async (url, config) => {
          if (url === '/users') {
            return config?.params?.q
              ? listResponse([existing], 0, 100, 1)
              : listResponse()
          }
          if (url === '/organizational-units') {
            return listResponse([unit], 0, 100)
          }
          throw new Error(`Unexpected Core API directory request ${url}`)
        })
      const createSpy = vi
        .spyOn(coreApi, 'postWithMetaAndEtag')
        .mockRejectedValue(uncertainMutationError())
      const { screen } = await renderMembers()

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
      await expect.element(screen.getByText(metadataMessage)).toBeVisible()
      await expect
        .element(
          screen.getByText(`Matching authorized account: ${existingName}`)
        )
        .toBeVisible()
      expect(createSpy).toHaveBeenCalledTimes(1)
      expect(getSpy.mock.calls.some(([, config]) => config?.params?.q)).toBe(
        true
      )
      await expect
        .element(screen.getByRole('button', { name: 'Review preserved draft' }))
        .not.toBeInTheDocument()
      await expect
        .element(
          screen.getByRole('button', { name: 'Review existing account' })
        )
        .toBeVisible()
    }
  )

  it('retries failed creation verification with GET only and opens a draft only after a verified no-match', async () => {
    let reconciliationReads = 0
    const verificationError = new CoreApiError({
      message: 'Directory verification is temporarily unavailable.',
      code: 'DIRECTORY_UNAVAILABLE',
      kind: 'network',
    })
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url === '/users') {
          if (config?.params?.q) {
            reconciliationReads += 1
            if (reconciliationReads === 1) {
              throw verificationError
            }
            return listResponse([], 0, 100, 0)
          }
          return listResponse()
        }
        if (url === '/organizational-units') {
          return listResponse([unit], 0, 100)
        }
        throw new Error(`Unexpected Core API directory request ${url}`)
      })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(uncertainMutationError())
      .mockResolvedValueOnce({
        data: {
          ...member,
          id: '33333333-3333-4333-8333-333333333333',
          email: 'new.person@example.test',
          displayName: 'New Person',
          primaryOrgUnitId: null,
          accountStatus: 'PENDING_SETUP',
        },
        meta: {},
        etag: 'W/"v-2"',
      })
    const { screen } = await renderMembers()

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

    await expect
      .element(screen.getByText(/verification is temporarily unavailable/i))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Retry verification' }))
      .toBeEnabled()
    expect(createSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry verification' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Review preserved draft' }))
      .toBeEnabled()
    expect(reconciliationReads).toBe(2)
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(
      getSpy.mock.calls.filter(
        ([url, config]) => url === '/users' && config?.params?.q
      )
    ).toHaveLength(2)

    await userEvent.click(
      screen.getByRole('button', { name: 'Review preserved draft' })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('New Person')
    await expect
      .element(screen.getByRole('textbox', { name: 'Email' }))
      .toHaveValue('new.person@example.test')
    expect(createSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => createSpy.mock.calls.length).toBe(2)
    expect(createSpy).toHaveBeenCalledTimes(2)
  })

  it('does not claim global email availability for a Department Manager no-match', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === '/users') {
        return config?.params?.q ? listResponse([], 0, 100, 0) : listResponse()
      }
      if (url === '/organizational-units') {
        return listResponse([unit], 0, 100)
      }
      throw new Error(`Unexpected Core API directory request ${url}`)
    })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers(identity('DEPARTMENT_MANAGER'))

    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Scoped Draft'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Email' }),
      'scoped@example.test'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Primary organizational unit' })
    )
    await userEvent.click(screen.getByRole('option', { name: /Operations/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect
      .element(screen.getByText(/no matching account is visible.*scope/i))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Review preserved draft' }))
      .toBeEnabled()
    await expect
      .element(
        screen.getByText(
          /does not establish that the email is globally unused/i
        )
      )
      .toBeVisible()
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores a delayed creation verification after its operation has closed', async () => {
    let finishVerification!: (response: ReturnType<typeof listResponse>) => void
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url === '/users') {
          if (config?.params?.q) {
            return new Promise((resolve) => {
              finishVerification = resolve
            }) as never
          }
          return listResponse()
        }
        if (url === '/organizational-units') {
          return listResponse([unit], 0, 100)
        }
        throw new Error(`Unexpected Core API directory request ${url}`)
      })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'First Draft'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Email' }),
      'first@example.test'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => Boolean(finishVerification)).toBe(true)
    expect(createSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(screen.getByRole('button', { name: 'Review preserved draft' }))
      .not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Second Draft'
    )
    finishVerification(listResponse([member], 0, 100, 1))

    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('Second Draft')
    expect(getSpy).toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledTimes(1)
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

  it('refreshes current presentation for a self display-name update without session revocation', async () => {
    const self = {
      ...member,
      id: identity('ADMINISTRATOR').userId,
      displayName: 'Directory Operator',
      globalRole: 'ADMINISTRATOR',
    }
    mockDirectory({ directory: listResponse([self]) })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: self, meta: {}, etag: 'W/"self-v1"' })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...self, displayName: 'Updated Operator' },
        meta: {},
        etag: 'W/"self-v2"',
      })
    const { screen, identityRead } = await renderMembers()
    const identityReadsBeforeMutation = identityRead.mock.calls.length

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Directory Operator' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Updated Operator'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)
    await expect
      .poll(() => identityRead.mock.calls.length)
      .toBeGreaterThan(identityReadsBeforeMutation)
    expect(detailSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .not.toBeInTheDocument()
  })

  it('does not refresh current identity when another member changes display name', async () => {
    mockDirectory()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: member, meta: {}, etag: 'W/"member-v1"' })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...member, displayName: 'Renamed Member' },
        meta: {},
        etag: 'W/"member-v2"',
      })
    const { screen, identityRead } = await renderMembers()
    const identityReadsBeforeMutation = identityRead.mock.calls.length

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Renamed Member'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .not.toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(identityRead.mock.calls.length).toBe(identityReadsBeforeMutation)
  })

  it('processes a confirmed member mutation while compatible identity verification is pending', async () => {
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: member,
      meta: {},
      etag: 'W/"member-v1"',
    })
    let resolvePatch!: (value: unknown) => void
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePatch = resolve
          }) as never
      )
    const { queryClient, screen, identityRead } = await renderMembers()
    const identityReadsBeforeRefresh = identityRead.mock.calls.length

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Renamed During Verification'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)

    let resolveIdentity!: (value: unknown) => void
    identityRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve
        }) as never
    )
    const refresh = queryClient.invalidateQueries({
      queryKey: currentUserQueryKey,
    })
    await expect
      .poll(() => identityRead.mock.calls.length)
      .toBeGreaterThan(identityReadsBeforeRefresh)

    resolvePatch({
      data: { ...member, displayName: 'Renamed During Verification' },
      meta: {},
      etag: 'W/"member-v2"',
    })
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)

    resolveIdentity(identity('ADMINISTRATOR'))
    await refresh
  })

  it('preserves a rejected mutation while compatible identity verification is pending', async () => {
    mockDirectory()
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: member, meta: {}, etag: 'W/"member-v1"' })
    let rejectPatch!: (error: unknown) => void
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectPatch = reject
          }) as never
      )
    const { queryClient, screen, identityRead } = await renderMembers()
    const identityReadsBeforeRefresh = identityRead.mock.calls.length

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'Rejected During Verification'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)

    let resolveIdentity!: (value: unknown) => void
    identityRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve
        }) as never
    )
    const refresh = queryClient.invalidateQueries({
      queryKey: currentUserQueryKey,
    })
    await expect
      .poll(() => identityRead.mock.calls.length)
      .toBeGreaterThan(identityReadsBeforeRefresh)

    rejectPatch(
      new CoreApiError({
        message: 'The member update was rejected.',
        code: 'VALIDATION_FAILED',
        status: 422,
        kind: 'http',
      })
    )
    await expect
      .element(screen.getByText(/Core API rejected/i).first())
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Save member' }))
      .toBeDisabled()
    expect(detailSpy).toHaveBeenCalledTimes(1)

    resolveIdentity(identity('ADMINISTRATOR'))
    await refresh
    await expect
      .element(screen.getByRole('button', { name: 'Save member' }))
      .toBeEnabled()
  })

  it('settles an initial member snapshot when verification interrupts its response', async () => {
    mockDirectory()
    let resolveDetail!: (value: unknown) => void
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDetail = resolve
          }) as never
      )
    const { queryClient, screen, identityRead } = await renderMembers()
    const identityReadsBeforeRefresh = identityRead.mock.calls.length

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await expect
      .element(screen.getByText('Loading member details…'))
      .toBeVisible()

    let resolveIdentity!: (value: unknown) => void
    identityRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve
        }) as never
    )
    const refresh = queryClient.invalidateQueries({
      queryKey: currentUserQueryKey,
    })
    await expect
      .poll(() => identityRead.mock.calls.length)
      .toBeGreaterThan(identityReadsBeforeRefresh)

    resolveDetail({ data: member, meta: {}, etag: 'W/"member-v1"' })
    await expect
      .element(screen.getByText('Member details could not be loaded'))
      .toBeVisible()
    expect(detailSpy).toHaveBeenCalledTimes(1)

    resolveIdentity(identity('ADMINISTRATOR'))
    await refresh
    detailSpy.mockResolvedValueOnce({
      data: member,
      meta: {},
      etag: 'W/"member-v2"',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry member details' })
    )
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .toBeVisible()
    expect(detailSpy).toHaveBeenCalledTimes(2)
  })

  it('suspends privileged interaction before unrelated invalidation for a self role update', async () => {
    const self = {
      ...member,
      id: identity('ADMINISTRATOR').userId,
      displayName: 'Directory Operator',
      globalRole: 'ADMINISTRATOR',
    }
    mockDirectory({ directory: listResponse([self]) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: self,
      meta: {},
      etag: 'W/"self-role-v1"',
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...self, globalRole: 'EMPLOYEE' },
        meta: {},
        etag: 'W/"self-role-v2"',
      })
    const { screen, identityRead } = await renderMembers()
    let resolveIdentityRefresh!: (value: unknown) => void
    identityRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentityRefresh = resolve
        }) as never
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Directory Operator' })
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Global role' }))
    await userEvent.click(screen.getByRole('option', { name: 'Employee' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)
    await expect.poll(() => identityRead.mock.calls.length).toBeGreaterThan(0)
    await expect
      .element(screen.getByRole('button', { name: 'Saving…' }))
      .toBeDisabled()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    resolveIdentityRefresh(identity('ADMINISTRATOR'))
  })

  it('keeps a name edit while adopting an independent server unit change and sends the reviewed ETag', async () => {
    const original = {
      ...member,
      displayName: 'John',
      primaryOrgUnitId: unit.id,
    }
    const latest = { ...original, primaryOrgUnitId: productUnit.id }
    mockDirectory({ units: listResponse([unit, productUnit], 0, 100) })
    let detailReads = 0
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => {
      detailReads += 1
      return detailReads === 1
        ? { data: original, meta: {}, etag: 'W/"v-1"' }
        : { data: latest, meta: {}, etag: 'W/"v-2"' }
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
      .mockResolvedValueOnce({
        data: { ...latest, displayName: 'John Nguyen' },
        meta: {},
        etag: 'W/"v-3"',
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
      'John Nguyen'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect
      .element(
        screen.getByRole('button', {
          name: 'Keep intended changes and continue',
        })
      )
      .toBeEnabled()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Discard my edits and restart from latest',
        })
      )
      .toBeEnabled()
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Keep intended changes and continue',
      })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('John Nguyen')
    await expect
      .element(
        screen.getByRole('combobox', {
          name: 'Primary organizational unit',
        })
      )
      .toHaveTextContent('Product')
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(2)
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}`,
      { displayName: 'John Nguyen' },
      { headers: { 'If-Match': 'W/"v-2"' } }
    )
  })

  it('requires a separate conflict choice and save before sending the intended value', async () => {
    const original = { ...member, displayName: 'John' }
    const latest = { ...member, displayName: 'Server Name' }
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"v-1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"v-2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
      .mockResolvedValueOnce({
        data: { ...latest, displayName: 'My Name' },
        meta: {},
        etag: 'W/"v-3"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'My Name'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    const resolve = screen.getByRole('button', {
      name: 'Resolve conflicts and continue',
    })
    await expect.element(resolve).toBeDisabled()
    await expect
      .element(screen.getByRole('radio', { name: /server value/i }))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('radio', { name: /your intended value/i })
    )
    await userEvent.click(resolve)

    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('My Name')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(2)
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}`,
      { displayName: 'My Name' },
      { headers: { 'If-Match': 'W/"v-2"' } }
    )
  })

  it('accepts a conflicting latest value without resending the discarded intent', async () => {
    const original = { ...member, displayName: 'John' }
    const latest = { ...member, displayName: 'Server Name' }
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"v-1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"v-2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'My Name'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await userEvent.click(screen.getByRole('radio', { name: /server value/i }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Resolve conflicts and continue' })
    )

    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('Server Name')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('requires explicit review before retaining a manager-scope assignment after a role conflict', async () => {
    const original = {
      ...member,
      globalRole: 'EMPLOYEE',
      managerScopeUnitIds: [],
    }
    const latest = {
      ...member,
      globalRole: 'ADMINISTRATOR',
      managerScopeUnitIds: [],
    }
    mockDirectory({ units: listResponse([unit, productUnit], 0, 100) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"role-v1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"role-v2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
      .mockResolvedValueOnce({
        data: {
          ...latest,
          globalRole: 'DEPARTMENT_MANAGER',
          managerScopeUnitIds: [productUnit.id],
        },
        meta: {},
        etag: 'W/"role-v3"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Global role' }))
    await userEvent.click(
      screen.getByRole('option', { name: 'Department manager' })
    )
    await expect
      .element(screen.getByRole('checkbox', { name: 'Product (PROD)' }))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Product (PROD)' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    const resolve = screen.getByRole('button', {
      name: 'Resolve conflicts and continue',
    })
    await expect.element(resolve).toBeDisabled()
    await userEvent.click(
      screen.getByRole('radio', {
        name: /your intended value.*DEPARTMENT_MANAGER/i,
      })
    )
    await expect
      .element(screen.getByText(/grants being assigned: Product/i))
      .toBeVisible()
    await expect.element(resolve).toBeDisabled()
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /i understand this assigns manager access to the selected units/i,
      })
    )
    await userEvent.click(resolve)

    await expect
      .element(screen.getByRole('combobox', { name: 'Global role' }))
      .toHaveTextContent('Department manager')
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(2)
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}`,
      {
        globalRole: 'DEPARTMENT_MANAGER',
        managerScopeUnitIds: [productUnit.id],
      },
      { headers: { 'If-Match': 'W/"role-v2"' } }
    )
  })

  it('explicitly discards the old edit when restarting from the latest snapshot', async () => {
    const original = { ...member, displayName: 'John' }
    const latest = { ...member, displayName: 'Server Name' }
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"v-1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"v-2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'My Name'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Discard my edits and restart from latest',
      })
    )

    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('Server Name')
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('invalidates a conflict choice when a newer authoritative version removes that conflict', async () => {
    const original = { ...member, displayName: 'John' }
    const conflicting = { ...member, displayName: 'Server Name' }
    const latest = { ...member, displayName: 'My Name' }
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"v-1"',
      })
      .mockResolvedValueOnce({
        data: conflicting,
        meta: {},
        etag: 'W/"v-2"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"v-3"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Name' }),
      'My Name'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await userEvent.click(
      screen.getByRole('radio', { name: /your intended value/i })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest for review' })
    )

    await expect
      .element(
        screen.getByRole('button', {
          name: 'Keep intended changes and continue',
        })
      )
      .toBeEnabled()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Resolve conflicts and continue',
        })
      )
      .not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Keep intended changes and continue',
      })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue('My Name')
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('demotes a Department Manager with existing grants using the role-only contract', async () => {
    const managerMember = {
      ...member,
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unit.id, productUnit.id],
    }
    mockDirectory({ units: listResponse([unit, productUnit], 0, 100) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: managerMember,
      meta: {},
      etag: 'W/"manager-v1"',
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: {
          ...managerMember,
          globalRole: 'EMPLOYEE',
          managerScopeUnitIds: [],
        },
        meta: {},
        etag: 'W/"manager-v2"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Global role' }))
    await userEvent.click(screen.getByRole('option', { name: 'Employee' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect.poll(() => patchSpy.mock.calls.length).toBe(1)
    expect(patchSpy).toHaveBeenCalledWith(
      `/users/${memberId}`,
      { globalRole: 'EMPLOYEE' },
      { headers: { 'If-Match': 'W/"manager-v1"' } }
    )
  })

  it('requires explicit review before a demotion removes independently changed manager grants', async () => {
    const original = {
      ...member,
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unit.id],
    }
    const latest = {
      ...original,
      managerScopeUnitIds: [unit.id, productUnit.id],
    }
    mockDirectory({ units: listResponse([unit, productUnit], 0, 100) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"manager-v1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"manager-v2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
      .mockResolvedValueOnce({
        data: { ...latest, globalRole: 'EMPLOYEE', managerScopeUnitIds: [] },
        meta: {},
        etag: 'W/"manager-v3"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Global role' }))
    await userEvent.click(screen.getByRole('option', { name: 'Employee' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await expect
      .element(screen.getByText(/demotion removes.*Operations.*Product/i))
      .toBeVisible()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Keep intended changes and continue',
        })
      )
      .toBeDisabled()
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /i understand this demotion removes all current manager grants/i,
      })
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Keep intended changes and continue',
      })
    )

    await expect
      .element(screen.getByRole('combobox', { name: 'Global role' }))
      .toHaveTextContent('Employee')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))
    await expect.poll(() => patchSpy.mock.calls.length).toBe(2)
    expect(patchSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}`,
      { globalRole: 'EMPLOYEE' },
      { headers: { 'If-Match': 'W/"manager-v2"' } }
    )
  })

  it('rejects an old scope replacement after the server demotes the target', async () => {
    const original = {
      ...member,
      globalRole: 'DEPARTMENT_MANAGER',
      managerScopeUnitIds: [unit.id],
    }
    const latest = {
      ...original,
      globalRole: 'EMPLOYEE',
      managerScopeUnitIds: [],
    }
    mockDirectory({ units: listResponse([unit, productUnit], 0, 100) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: original,
        meta: {},
        etag: 'W/"manager-v1"',
      })
      .mockResolvedValueOnce({
        data: latest,
        meta: {},
        etag: 'W/"employee-v2"',
      })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(staleMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Lee Member' })
    )
    await expect
      .element(screen.getByRole('dialog', { name: 'Edit member' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('checkbox', { name: /Operations/ }))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Operations (OPS)' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Product (PROD)' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save member' }))

    await userEvent.click(
      screen.getByRole('radio', { name: /your intended value.*Product/i })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Resolve conflicts and continue' })
    )
    await expect
      .element(screen.getByText(/separate.*role|role.*separately/i))
      .toBeVisible()
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('radio', { name: /server value.*none/i })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Resolve conflicts and continue' })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Name' }))
      .toHaveValue(member.displayName)
    await expect
      .element(screen.getByRole('combobox', { name: 'Global role' }))
      .toHaveTextContent('Employee')
    await expect
      .element(screen.getByRole('checkbox', { name: 'Product (PROD)' }))
      .not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
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

  it('does not repeat uncertain deactivation when the latest state is already inactive', async () => {
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: member,
        meta: {},
        etag: 'W/"v-9"',
      })
      .mockResolvedValueOnce({
        data: { ...member, accountStatus: 'INACTIVE' },
        meta: {},
        etag: 'W/"v-10"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate account' })
    )

    await expect
      .element(screen.getByText(/currently verifies this account as inactive/i))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(/cannot determine whether this request caused/i)
      )
      .toBeVisible()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Review and confirm lifecycle operation',
        })
      )
      .not.toBeInTheDocument()
  })

  it('requires renewed review and confirmation to retry an uncertain but still eligible deactivation', async () => {
    mockDirectory()
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: member,
        meta: {},
        etag: 'W/"v-9"',
      })
      .mockResolvedValueOnce({
        data: member,
        meta: {},
        etag: 'W/"v-10"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(uncertainMutationError())
      .mockResolvedValueOnce({
        data: { ...member, accountStatus: 'INACTIVE' },
        meta: {},
        etag: 'W/"v-11"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate account' })
    )
    const review = screen.getByRole('button', {
      name: 'Review and confirm lifecycle operation',
    })
    await expect.element(review).toBeEnabled()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(review)
    await expect
      .element(
        screen.getByRole('alertdialog', {
          name: 'Deactivate member account?',
        })
      )
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Deactivate account' })
    )
    await expect.poll(() => lifecycleSpy.mock.calls.length).toBe(2)
    expect(lifecycleSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}/deactivate`,
      undefined,
      { headers: { 'If-Match': 'W/"v-10"' } }
    )
  })

  it('does not repeat an uncertain reactivation after active state is verified', async () => {
    const inactiveMember = { ...member, accountStatus: 'INACTIVE' }
    mockDirectory({ directory: listResponse([inactiveMember]) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: inactiveMember,
        meta: {},
        etag: 'W/"v-20"',
      })
      .mockResolvedValueOnce({
        data: member,
        meta: {},
        etag: 'W/"v-21"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Reactivate account' })
    )

    await expect
      .element(screen.getByText(/currently verifies this account as active/i))
      .toBeVisible()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Review and confirm lifecycle operation',
        })
      )
      .not.toBeInTheDocument()
  })

  it('keeps an uncertain pending-setup reissue inconclusive and requires a fresh confirmed action', async () => {
    const pendingMember = { ...member, accountStatus: 'PENDING_SETUP' }
    const pendingAfterRead = {
      ...pendingMember,
      updatedAt: '2026-11-24T01:00:00Z',
    }
    mockDirectory({ directory: listResponse([pendingMember]) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: pendingMember,
        meta: {},
        etag: 'W/"setup-v1"',
      })
      .mockResolvedValueOnce({
        data: pendingAfterRead,
        meta: {},
        etag: 'W/"setup-v2"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(uncertainMutationError())
      .mockResolvedValueOnce({
        data: pendingAfterRead,
        meta: {},
        etag: 'W/"setup-v3"',
      })
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Resend setup' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reissue setup' }))

    await expect
      .element(
        screen.getByText(
          /cannot independently establish whether.*reissue.*applied/i
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByText(/whether a setup email was delivered/i))
      .toBeVisible()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Review and confirm lifecycle operation',
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reissue setup' }))
    await expect.poll(() => lifecycleSpy.mock.calls.length).toBe(2)
    expect(lifecycleSpy).toHaveBeenLastCalledWith(
      `/users/${memberId}/account-setup/reissue`,
      undefined,
      { headers: { 'If-Match': 'W/"setup-v2"' } }
    )
  })

  it('shows the actual lifecycle state and prevents setup reissue when the account became active', async () => {
    const pendingMember = { ...member, accountStatus: 'PENDING_SETUP' }
    mockDirectory({ directory: listResponse([pendingMember]) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: pendingMember,
        meta: {},
        etag: 'W/"setup-v1"',
      })
      .mockResolvedValueOnce({
        data: member,
        meta: {},
        etag: 'W/"active-v2"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Resend setup' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reissue setup' }))

    await expect
      .element(screen.getByText(/latest state: active/i))
      .toBeVisible()
    await expect
      .element(screen.getByText(/remains pending secure setup/i))
      .not.toBeInTheDocument()
    await expect
      .element(
        screen.getByText(
          /initial account setup reissue is no longer available/i
        )
      )
      .toBeVisible()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Review and confirm lifecycle operation',
        })
      )
      .not.toBeInTheDocument()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
  })

  it('shows the actual inactive state and prevents setup reissue when the account became inactive', async () => {
    const pendingMember = { ...member, accountStatus: 'PENDING_SETUP' }
    const inactiveMember = { ...member, accountStatus: 'INACTIVE' }
    mockDirectory({ directory: listResponse([pendingMember]) })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: pendingMember,
        meta: {},
        etag: 'W/"setup-v1"',
      })
      .mockResolvedValueOnce({
        data: inactiveMember,
        meta: {},
        etag: 'W/"inactive-v2"',
      })
    const lifecycleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(uncertainMutationError())
    const { screen } = await renderMembers()

    await userEvent.click(screen.getByRole('button', { name: 'Resend setup' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reissue setup' }))

    await expect
      .element(screen.getByText(/latest state: inactive/i))
      .toBeVisible()
    await expect
      .element(screen.getByText(/remains pending secure setup/i))
      .not.toBeInTheDocument()
    await expect
      .element(
        screen.getByText(/initial account setup reissue is not available/i)
      )
      .toBeVisible()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Review and confirm lifecycle operation',
        })
      )
      .not.toBeInTheDocument()
    expect(lifecycleSpy).toHaveBeenCalledTimes(1)
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
