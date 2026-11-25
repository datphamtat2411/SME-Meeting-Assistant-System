import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ActionItem } from './action-api'
import { ActionCommands } from './action-commands'

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
