import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { i18n, setUiLanguage } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import type { ActionItem } from './action-api'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'
import { ActionItemsPage } from './index'

// The feature tests exercise real Action Items controls and queries, not the
// unrelated application-shell/sidebar context.
vi.mock('@/components/layout/header', () => ({ Header: () => null }))

const officialOpenItem: ActionItem = {
  id: '11111111-1111-4111-8111-111111111111',
  meetingId: '22222222-2222-4222-8222-222222222222',
  title: 'Review the launch checklist',
  details: null,
  status: 'OPEN',
  assigneeUserId: '33333333-3333-4333-8333-333333333333',
  dueDate: null,
  overdue: false,
  sourceType: 'MANUAL',
  transcriptId: null,
  contentRevision: null,
  isOfficial: true,
  processingJobId: null,
  createdByUserId: null,
  confirmedByUserId: null,
  confirmedAt: null,
  completedByUserId: null,
  completedAt: null,
  cancelledByUserId: null,
  cancelledAt: null,
  version: 1,
  createdAt: '2026-11-25T08:00:00Z',
  updatedAt: '2026-11-25T08:00:00Z',
  capabilities: {
    canEdit: true,
    canAssign: true,
    canConfirm: false,
    canReject: false,
    canStart: true,
    canComplete: true,
    canCancel: false,
    canReopen: false,
    canAccessMeeting: true,
    canAccessEvidence: false,
  },
  assignee: {
    id: '33333333-3333-4333-8333-333333333333',
    displayName: 'Alex Example',
    active: true,
  },
  meeting: {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Launch planning',
    restricted: false,
  },
  evidence: {
    availability: 'NOT_APPLICABLE',
    transcriptId: null,
    contentRevision: null,
    freshness: 'NOT_APPLICABLE',
    references: [],
    limitation: null,
  },
}

async function renderCommands(
  item: ActionItem,
  options: { currentUserId: string; canManageActionItems: boolean }
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <ActionCommands item={item} {...options} />
    </QueryClientProvider>
  )
}

describe('ActionCommands workspace authorization', () => {
  it('preserves official assignee progress operations without offering manager-only commands', async () => {
    const screen = await renderCommands(officialOpenItem, {
      currentUserId: officialOpenItem.assigneeUserId!,
      canManageActionItems: false,
    })

    await expect
      .element(screen.getByRole('button', { name: 'Start' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Complete' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Cancel' }))
      .not.toBeInTheDocument()
  })

  it('does not grant assignee progress commands for an unconfirmed proposal', async () => {
    const screen = await renderCommands(
      {
        ...officialOpenItem,
        status: 'PROPOSED',
        sourceType: 'AI',
        confirmedByUserId: null,
        isOfficial: false,
        capabilities: {
          ...officialOpenItem.capabilities,
          canStart: false,
          canComplete: false,
          canConfirm: false,
          canReject: false,
        },
      },
      {
        currentUserId: officialOpenItem.assigneeUserId!,
        canManageActionItems: false,
      }
    )

    await expect
      .element(screen.getByRole('button', { name: 'Confirm' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Reject' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Start' }))
      .not.toBeInTheDocument()
  })

  it('keeps the existing scoped manager transitions available to the Action Items feature', async () => {
    const screen = await renderCommands(
      {
        ...officialOpenItem,
        status: 'PROPOSED',
        sourceType: 'AI',
        isOfficial: false,
        capabilities: {
          ...officialOpenItem.capabilities,
          canStart: false,
          canComplete: false,
          canConfirm: true,
          canReject: true,
        },
      },
      {
        currentUserId: '44444444-4444-4444-8444-444444444444',
        canManageActionItems: true,
      }
    )

    await expect
      .element(screen.getByRole('button', { name: 'Confirm' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Reject' }))
      .toBeInTheDocument()
  })

  it('does not expose Reopen for cancelled items', async () => {
    const screen = await renderCommands(
      { ...officialOpenItem, status: 'CANCELLED' },
      {
        currentUserId: '44444444-4444-4444-8444-444444444444',
        canManageActionItems: true,
      }
    )

    await expect
      .element(screen.getByRole('button', { name: 'Reopen' }))
      .not.toBeInTheDocument()
  })
})

function reviewClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(currentUserQueryKey, {
    userId: officialOpenItem.assigneeUserId,
    session: { id: '44444444-4444-4444-8444-444444444444' },
  })
  return client
}

function reviewResult(item: ActionItem, etag: string) {
  return { data: item, meta: {}, etag }
}

describe('Action Item reviewed operation ownership', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(async () => {
    await setUiLanguage('en')
    localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  })

  it('does not revive a cancelled review when management authority returns', async () => {
    const client = reviewClient()
    const managed = {
      ...officialOpenItem,
      capabilities: { ...officialOpenItem.capabilities, canCancel: true },
    }
    const detail = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue(reviewResult(managed, '"reviewed"'))
    const view = (item: ActionItem) => (
      <QueryClientProvider client={client}>
        <ActionCommands item={item} />
      </QueryClientProvider>
    )
    const screen = await render(view(managed))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()

    await screen.rerender(view(officialOpenItem))
    await expect
      .element(screen.getByRole('alertdialog'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Complete' }))
      .toBeEnabled()

    await screen.rerender(view(managed))
    await expect
      .element(screen.getByRole('alertdialog'))
      .not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(detail).toHaveBeenCalledTimes(2)
  })

  it.each(['en', 'vi'] as const)(
    'reconciles a malformed command receipt without replaying the command (%s)',
    async (language) => {
      const client = reviewClient()
      const keys = [
        ['dashboard', 'me', 'actor-scope'],
        ['dashboard', 'management', 'manager-scope'],
        ['minutes', officialOpenItem.meetingId],
        ['export', 'pdf', officialOpenItem.meetingId, 'PDF', 'actor-scope'],
        ['action-items', 'list', { assignee: 'me' }, undefined, 'actor-scope'],
      ]
      for (const key of keys) client.setQueryData(key, { observed: true })
      const intelligenceKeys = [
        ['meeting-intelligence', officialOpenItem.meetingId, 'summary'],
        ['meeting-intelligence', officialOpenItem.meetingId, 'decisions'],
      ]
      for (const key of intelligenceKeys) {
        client.setQueryData(key, { observed: true })
      }
      const latest: ActionItem = {
        ...officialOpenItem,
        status: 'DONE',
        version: 2,
        capabilities: {
          ...officialOpenItem.capabilities,
          canComplete: false,
          canEdit: false,
          canAssign: false,
          canStart: false,
          canReopen: true,
        },
      }
      const detail = vi
        .spyOn(coreApi, 'getWithMetaAndEtag')
        .mockResolvedValueOnce(reviewResult(officialOpenItem, '"reviewed"'))
        .mockResolvedValueOnce(reviewResult(latest, '"latest"'))
      const post = vi
        .spyOn(coreApi, 'postWithMetaAndEtag')
        .mockResolvedValue(
          reviewResult(
            { ...latest, id: '99999999-9999-4999-8999-999999999999' },
            '"invalid"'
          )
        )
      const screen = await render(
        <QueryClientProvider client={client}>
          <ActionCommands item={officialOpenItem} />
        </QueryClientProvider>
      )
      await userEvent.click(screen.getByRole('button', { name: 'Complete' }))
      const dialog = screen.getByRole('alertdialog')
      await act(async () => {
        await setUiLanguage(language)
      })
      await userEvent.click(
        dialog.getByRole('button', { name: i18n.t('action-items:complete') })
      )
      await expect
        .element(
          screen.getByText(i18n.t('action-items:commandNoLongerEligible'))
        )
        .toBeInTheDocument()
      await expect
        .element(
          dialog.getByRole('button', { name: i18n.t('action-items:complete') })
        )
        .toBeDisabled()
      expect(detail).toHaveBeenCalledTimes(2)
      expect(post).toHaveBeenCalledOnce()
      for (const key of keys) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(true)
      }
      for (const key of intelligenceKeys) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(false)
      }
    }
  )

  it('requires a new editor review after editing authority is lost and restored', async () => {
    const client = reviewClient()
    const item: ActionItem = {
      ...officialOpenItem,
      capabilities: {
        ...officialOpenItem.capabilities,
        canAccessMeeting: false,
      },
    }
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue(
      reviewResult(item, '"reviewed"')
    )
    const view = (current: ActionItem) => (
      <QueryClientProvider client={client}>
        <ActionForm open onOpenChange={() => {}} item={current} />
      </QueryClientProvider>
    )
    const screen = await render(view(item))
    await expect
      .element(screen.getByRole('button', { name: 'Save changed fields' }))
      .toBeEnabled()

    await screen.rerender(
      view({
        ...item,
        capabilities: { ...item.capabilities, canEdit: false },
      })
    )
    await expect
      .element(screen.getByText('Action Item review expired'))
      .toBeInTheDocument()
    await screen.rerender(view(item))
    await expect
      .element(screen.getByRole('button', { name: 'Save changed fields' }))
      .not.toBeInTheDocument()
  })
})

const otherMeeting = '77777777-7777-4777-8777-777777777777'

function pageResponse<T>(items: T[], page = 0, totalElements = items.length) {
  const totalPages = Math.ceil(totalElements / 20)
  return {
    data: items,
    meta: {
      pagination: {
        page,
        size: 20,
        totalElements,
        totalPages,
        hasPrevious: page > 0,
        hasNext: page + 1 < totalPages,
      },
    },
  }
}

function candidate(index: number, displayName: string) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    displayName,
    email: `candidate${index}@example.invalid`,
    organizationalUnitName: null,
    active: true,
  }
}

const targets = pageResponse([
  {
    id: officialOpenItem.meetingId,
    label: 'Launch planning',
    restricted: false,
  },
  { id: otherMeeting, label: 'Second meeting', restricted: false },
])

async function renderCreateForm() {
  return render(
    <QueryClientProvider client={reviewClient()}>
      <ActionForm open canManageActionItems onOpenChange={() => {}} />
    </QueryClientProvider>
  )
}

describe('Wave 02 scoped Action Item discovery', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('selects an assignee from page two and resets pagination on a new search', async () => {
    const lookup = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (path, config) => {
        if (path === '/action-items/management-targets') return targets
        if (path !== '/action-items/assignee-candidates') {
          throw new Error(`Unexpected lookup: ${path}`)
        }
        const { page, q } = config?.params ?? {}
        if (q === 'Beta') {
          return pageResponse([candidate(22, 'Beta assignee')])
        }
        if (page === '1') {
          return pageResponse([candidate(21, 'Alex page two')], 1, 21)
        }
        return pageResponse(
          Array.from({ length: 20 }, (_, i) =>
            candidate(i + 1, `Alex result ${i + 1}`)
          ),
          0,
          21
        )
      })
    const screen = await renderCreateForm()
    await userEvent.click(
      screen.getByRole('button', { name: 'Launch planning' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Review'
    )
    const search = screen.getByRole('textbox', {
      name: 'Primary responsibility',
    })
    await userEvent.fill(search, 'Alex')
    await expect
      .element(screen.getByRole('button', { name: /Alex result 1 ·/ }))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next', exact: true }).last()
    )
    await userEvent.click(
      screen.getByRole('button', { name: /Alex page two ·/ })
    )
    await expect
      .element(
        screen.getByRole('button', { name: 'Create official Action Item' })
      )
      .toBeEnabled()
    expect(lookup).toHaveBeenCalledWith(
      '/action-items/assignee-candidates',
      expect.objectContaining({
        params: expect.objectContaining({
          meetingId: officialOpenItem.meetingId,
          q: 'Alex',
          page: '1',
        }),
      })
    )
    await userEvent.fill(search, 'Beta')
    await expect
      .element(screen.getByRole('button', { name: /Beta assignee ·/ }))
      .toBeInTheDocument()
    expect(lookup).toHaveBeenCalledWith(
      '/action-items/assignee-candidates',
      expect.objectContaining({
        params: expect.objectContaining({ q: 'Beta', page: '0' }),
      })
    )
  })

  it('does not reuse a delayed candidate response after changing meetings', async () => {
    const oldReply = pageResponse([candidate(1, 'Old scoped assignee')])
    let releaseOld!: (value: typeof oldReply) => void
    const pending = new Promise<typeof oldReply>((resolve) => {
      releaseOld = resolve
    })
    let oldSignal: { aborted: boolean } | undefined
    const lookup = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (path, config) => {
        if (path === '/action-items/management-targets') return targets
        if (path !== '/action-items/assignee-candidates') {
          throw new Error(`Unexpected lookup: ${path}`)
        }
        if (config?.params.meetingId === officialOpenItem.meetingId) {
          if (config?.params.q === 'Initial') {
            return pageResponse([candidate(3, 'Initial assignee')])
          }
          oldSignal = config?.signal
          return pending
        }
        return pageResponse([candidate(2, 'New scoped assignee')])
      })
    const screen = await renderCreateForm()
    const submit = screen.getByRole('button', {
      name: 'Create official Action Item',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Launch planning' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Review'
    )
    const search = screen.getByRole('textbox', {
      name: 'Primary responsibility',
    })
    await userEvent.fill(search, 'Initial')
    await userEvent.click(
      screen.getByRole('button', { name: /Initial assignee ·/ })
    )
    await expect.element(submit).toBeEnabled()
    await userEvent.fill(search, 'Alex')
    await expect.poll(() => oldSignal !== undefined).toBe(true)
    try {
      await userEvent.click(
        screen.getByRole('button', { name: 'Second meeting' })
      )
      await expect.element(search).toHaveValue('')
      await expect.element(submit).toBeDisabled()
      await userEvent.fill(search, 'Alex')
      await expect
        .element(screen.getByRole('button', { name: /New scoped assignee ·/ }))
        .toBeInTheDocument()
      expect(lookup).toHaveBeenCalledWith(
        '/action-items/assignee-candidates',
        expect.objectContaining({
          params: expect.objectContaining({
            meetingId: otherMeeting,
            q: 'Alex',
            page: '0',
          }),
        })
      )
      await expect.poll(() => oldSignal?.aborted).toBe(true)
      releaseOld(oldReply)
      await pending
      await expect
        .element(screen.getByRole('button', { name: /Old scoped assignee ·/ }))
        .not.toBeInTheDocument()
      await expect.element(submit).toBeDisabled()
      await userEvent.click(
        screen.getByRole('button', { name: /New scoped assignee ·/ })
      )
      await expect.element(submit).toBeEnabled()
    } finally {
      releaseOld(oldReply)
    }
  })

  it('keeps reviewable proposal scope while searching and paging the actual list', async () => {
    const proposal = (index: number): ActionItem => ({
      ...officialOpenItem,
      id: candidate(index, '').id,
      title: `Review proposal ${index}`,
      status: 'PROPOSED',
      sourceType: 'AI',
      isOfficial: false,
      meeting: { ...officialOpenItem.meeting, restricted: true },
      capabilities: {
        ...officialOpenItem.capabilities,
        canStart: false,
        canComplete: false,
        canAccessMeeting: false,
        canConfirm: true,
        canReject: true,
      },
    })
    const lookup = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (path, config) => {
        if (path === '/action-items/management-capability') {
          return { data: { canCreate: false }, meta: {} }
        }
        if (path !== '/action-items') {
          throw new Error(`Unexpected lookup: ${path}`)
        }
        if (config?.params.reviewable !== 'true') return pageResponse([])
        if (config?.params.q !== 'release') return pageResponse([proposal(1)])
        if (config?.params.page === '1') {
          return pageResponse([proposal(21)], 1, 21)
        }
        return pageResponse(
          Array.from({ length: 20 }, (_, i) => proposal(i + 1)),
          0,
          21
        )
      })
    const root = createRootRoute({ component: Outlet })
    const route = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: ActionItemsPage,
    })
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    const screen = await render(
      <QueryClientProvider client={reviewClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Review proposals' }))
    await expect
      .element(
        screen.getByRole('button', { name: 'Review proposal 1', exact: true })
      )
      .toBeInTheDocument()
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Search action items' }),
      'release'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await expect
      .element(screen.getByRole('button', { name: 'Review proposal 21' }))
      .toBeInTheDocument()
    for (const page of ['0', '1']) {
      expect(lookup).toHaveBeenCalledWith(
        '/action-items',
        expect.objectContaining({
          params: expect.objectContaining({
            official: 'false',
            status: 'PROPOSED',
            reviewable: 'true',
            q: 'release',
            page,
          }),
        })
      )
    }
  })
})
