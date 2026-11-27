import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import type { ActionItem } from './action-api'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'

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

  it('reconciles a malformed command receipt without replaying the command', async () => {
    const client = reviewClient()
    const keys = [
      ['dashboard', 'me', 'actor-scope'],
      ['dashboard', 'management', 'manager-scope'],
      ['minutes', officialOpenItem.meetingId],
      ['export', 'pdf', officialOpenItem.meetingId, 'PDF', 'actor-scope'],
      ['action-items', 'list', { assignee: 'me' }, undefined, 'actor-scope'],
    ]
    for (const key of keys) client.setQueryData(key, { observed: true })
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
    await userEvent.click(dialog.getByRole('button', { name: 'Complete' }))
    await expect
      .element(screen.getByText('This command is no longer eligible.'))
      .toBeInTheDocument()
    await expect
      .element(dialog.getByRole('button', { name: 'Complete' }))
      .toBeDisabled()
    expect(detail).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenCalledOnce()
    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    }
  })

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
