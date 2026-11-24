import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { CoreApiError, coreApi, resetCsrfToken } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { resetAuthLifecycleAfterSignIn } from '@/features/auth/session/auth-lifecycle'

vi.mock('react-top-loading-bar', () => ({
  default: () => null,
}))

const user = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'operator@example.test',
  displayName: 'Authorized Operator',
  globalRole: 'EMPLOYEE' as const,
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

const meetingA = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Meeting A',
  description: 'First authorized meeting.',
  organizerUserId: user.userId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'IN_PROGRESS' as const,
  startedAt: '2026-11-23T00:00:00Z',
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: user.userId,
  createdAt: '2026-11-23T00:00:00Z',
  updatedAt: '2026-11-23T00:00:00Z',
}

const meetingB = {
  ...meetingA,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Meeting B',
  description: 'Second authorized meeting.',
  status: 'ENDED' as const,
  endedAt: '2026-11-23T01:00:00Z',
}

const activeMembership = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  meetingId: meetingA.id,
  userId: user.userId,
  addedByUserId: user.userId,
  addedAt: '2026-11-23T00:00:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: user.displayName,
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function apiError(status: number) {
  return new CoreApiError({
    message: status === 403 ? 'Forbidden' : 'Authentication required',
    status,
    kind: 'http',
  })
}

function installAuthorizedApi() {
  const detailReads = vi
    .spyOn(coreApi, 'getWithMetaAndEtag')
    .mockImplementation(async (url) => {
      const parts = url.split('/')
      const id = decodeURIComponent(parts[parts.length - 1] ?? '')
      const meeting = id === meetingB.id ? meetingB : meetingA
      return {
        data: meeting,
        meta: {},
        etag: `"etag-${meeting.id}"`,
      }
    })
  const metadataReads = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url) => {
      if (url.endsWith('/participants')) {
        const parts = url.split('/')
        const meetingId = decodeURIComponent(parts[parts.length - 2] ?? '')
        return {
          data: [
            {
              ...activeMembership,
              meetingId,
            },
          ],
          meta: {},
        }
      }
      throw new Error(`Unexpected metadata read ${url}`)
    })
  const reads = vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    if (url === '/auth/me') return user
    if (url.endsWith('/media')) return []
    if (url.endsWith('/transcript')) {
      throw new CoreApiError({
        message: 'Transcript is not ready',
        status: 404,
        kind: 'http',
      })
    }
    if (url.endsWith('/speaker-clusters')) return []
    throw new Error(`Unexpected read ${url}`)
  })

  return { detailReads, metadataReads, reads }
}

async function renderRoute(initialPath: string) {
  const queryClient = createQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <FontProvider>
          <DirectionProvider>
            <RouterProvider router={router} />
          </DirectionProvider>
        </FontProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
  return { router, screen }
}

describe('generated meeting route coexistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetCsrfToken()
    resetAuthLifecycleAfterSignIn()
  })

  it('keeps detail, live, and operator identities separate across navigation', async () => {
    const api = installAuthorizedApi()
    const { router, screen } = await renderRoute(`/meetings/${meetingA.id}`)
    const { detailReads, metadataReads } = api

    await expect
      .element(screen.getByRole('heading', { name: 'Meeting A' }))
      .toBeInTheDocument()
    expect(router.state.matches.map((match) => match.routeId)).toContain(
      '/_authenticated/meetings/$meetingId'
    )
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Recording' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Transcript' }))
      .toBeInTheDocument()

    await router.navigate({
      to: '/meetings/$meetingId/live',
      params: { meetingId: meetingA.id },
    })
    await expect.element(screen.getByText('Live route')).toBeInTheDocument()
    expect(router.state.matches.map((match) => match.routeId)).toContain(
      '/_authenticated/meetings/$meetingId/live'
    )
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .not.toBeInTheDocument()

    await router.navigate({
      to: '/meetings/$meetingId',
      params: { meetingId: meetingB.id },
    })
    await expect
      .element(screen.getByRole('heading', { name: 'Meeting B' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting A', { exact: true }))
      .not.toBeInTheDocument()
    expect(router.state.matches.map((match) => match.routeId)).toContain(
      '/_authenticated/meetings/$meetingId'
    )

    const detailsBeforeOperator = detailReads.mock.calls.length
    const metadataBeforeOperator = metadataReads.mock.calls.length
    await router.navigate({ to: '/meetings/operator-mi-e2e' })
    await expect
      .element(
        screen.getByRole('heading', { name: 'Vietnamese MI E2E workflow' })
      )
      .toBeInTheDocument()
    expect(router.state.matches.map((match) => match.routeId)).toContain(
      '/_authenticated/meetings/operator-mi-e2e'
    )
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .not.toBeInTheDocument()
    expect(detailReads.mock.calls.length).toBe(detailsBeforeOperator)
    expect(metadataReads.mock.calls.length).toBe(metadataBeforeOperator)
  })

  it('preserves an authorized direct workspace section through verification', async () => {
    installAuthorizedApi()
    const { router, screen } = await renderRoute(
      `/meetings/${meetingA.id}?section=transcript`
    )

    await expect
      .element(screen.getByRole('tab', { name: 'Transcript' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Transcript not available yet'))
      .toBeInTheDocument()
    expect(router.state.location.search.section).toBe('transcript')
  })

  it('redirects anonymous meeting deep links to sign-in without mounting descendants', async () => {
    const authRead = vi.spyOn(coreApi, 'get')

    authRead.mockRejectedValue(apiError(401))
    const anonymous = await renderRoute(`/meetings/${meetingA.id}`)
    await expect
      .poll(() => anonymous.router.state.location.pathname)
      .toBe('/sign-in')
    await expect
      .element(anonymous.screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
  })

  it('renders a denied state without mounting protected meeting descendants', async () => {
    const deniedReads = vi
      .spyOn(coreApi, 'get')
      .mockRejectedValue(apiError(403))
    const denied = await renderRoute(`/meetings/${meetingA.id}`)
    await expect
      .element(denied.screen.getByText('Access denied'))
      .toBeInTheDocument()
    expect(denied.router.state.location.pathname).toBe(
      `/meetings/${meetingA.id}`
    )
    expect(deniedReads).toHaveBeenCalledWith(
      '/auth/me',
      expect.objectContaining({ withCredentials: true })
    )
  })

  it('renders a missing-resource state without fetching protected descendants', async () => {
    const api = installAuthorizedApi()
    api.detailReads.mockRejectedValue(
      new CoreApiError({
        message: 'Meeting missing',
        status: 404,
        kind: 'http',
      })
    )
    const missing = await renderRoute(`/meetings/${meetingA.id}`)
    await expect
      .element(missing.screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect
      .element(missing.screen.getByRole('tab', { name: 'Overview' }))
      .not.toBeInTheDocument()
    expect(api.metadataReads).not.toHaveBeenCalled()
  })
})
