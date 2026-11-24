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
  processingJobId: null,
  createdByUserId: null,
  confirmedByUserId: null,
  confirmedAt: null,
  version: 1,
  createdAt: '2026-11-25T08:00:00Z',
  updatedAt: '2026-11-25T08:00:00Z',
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
      { ...officialOpenItem, status: 'PROPOSED', sourceType: 'AI' },
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
})
