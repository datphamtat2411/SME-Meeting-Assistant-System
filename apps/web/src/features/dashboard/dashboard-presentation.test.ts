import { describe, expect, it } from 'vitest'
import type { ActionItem } from '@/features/action-items/action-api'
import { mergeAssignedWork } from './dashboard-presentation'

const actor = '11111111-1111-4111-8111-111111111111'

function item(
  id: string,
  status: 'OPEN' | 'IN_PROGRESS',
  dueDate: string | null
): ActionItem {
  // The existing Action Items adapter validates the rest of the read model.
  return {
    id,
    status,
    dueDate,
    isOfficial: true,
    assigneeUserId: actor,
  } as ActionItem
}

describe('Dashboard assigned-work preview', () => {
  it('merges both pending states with null due dates last and a bounded result', () => {
    const open = [
      item('a', 'OPEN', '2026-11-25'),
      item('b', 'OPEN', '2026-11-28'),
      item('c', 'OPEN', null),
    ]
    const progress = [
      item('d', 'IN_PROGRESS', '2026-11-24'),
      item('e', 'IN_PROGRESS', '2026-11-25'),
      item('f', 'IN_PROGRESS', null),
    ]
    expect(
      mergeAssignedWork(open, progress, actor).map((value) => value.id)
    ).toEqual(['d', 'a', 'e', 'b', 'c'])
  })

  it('does not duplicate a task that moved status between bounded reads', () => {
    const open = item('a', 'OPEN', '2026-11-25')
    const progress = item('a', 'IN_PROGRESS', '2026-11-25')
    expect(mergeAssignedWork([open], [progress], actor)).toEqual([progress])
  })

  it('rejects proposed, wrong-owner, or malformed work', () => {
    const open = item('a', 'OPEN', null)
    expect(() =>
      mergeAssignedWork([{ ...open, isOfficial: false }], [], actor)
    ).toThrow(/scope/i)
    expect(() =>
      mergeAssignedWork([{ ...open, assigneeUserId: 'other' }], [], actor)
    ).toThrow(/scope/i)
    expect(() =>
      mergeAssignedWork([{ ...open, dueDate: 'not a date' }], [], actor)
    ).toThrow(/scope/i)
  })
})
