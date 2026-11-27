import { describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import {
  buildActionPatch,
  actionDetail,
  createAction,
  managementTargetsQuery,
  rebaseActionDraft,
  serializeActionFilter,
  type ActionEditValues,
  type ActionItem,
} from './action-api'

const item: ActionItem = {
  id: '11111111-1111-4111-8111-111111111111',
  meetingId: '22222222-2222-4222-8222-222222222222',
  title: 'Review the launch checklist',
  details: 'Bring the latest version.',
  status: 'PROPOSED',
  assigneeUserId: '33333333-3333-4333-8333-333333333333',
  dueDate: '2026-12-25',
  overdue: false,
  sourceType: 'AI_EXTRACTED',
  transcriptId: '55555555-5555-4555-8555-555555555555',
  contentRevision: 3,
  isOfficial: false,
  processingJobId: '44444444-4444-4444-8444-444444444444',
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
    canConfirm: true,
    canReject: true,
    canStart: false,
    canComplete: false,
    canCancel: false,
    canReopen: false,
    canAccessMeeting: true,
    canAccessEvidence: true,
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
    availability: 'AVAILABLE',
    transcriptId: '55555555-5555-4555-8555-555555555555',
    contentRevision: 3,
    freshness: 'CURRENT',
    references: [],
    limitation: null,
  },
}

describe('Action Item adapter contracts', () => {
  it('allows paged browsing without a protected meeting title', () => {
    const browse = managementTargetsQuery('', 1)
    expect(browse.enabled).toBe(true)
    expect(browse.queryKey[2]).toMatchObject({ q: '', page: '1' })
    expect(managementTargetsQuery('a').enabled).toBe(false)
    expect(managementTargetsQuery(item.meetingId).enabled).toBe(true)
  })

  it('rejects a detail response from a different meeting', async () => {
    const foreignMeetingId = '66666666-6666-4666-8666-666666666666'
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...item,
        meetingId: foreignMeetingId,
        meeting: { ...item.meeting, id: foreignMeetingId },
      },
      meta: {},
      etag: '"action-etag"',
    })

    await expect(actionDetail(item.id, item.meetingId)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  })

  it('marks a cross-meeting creation receipt as uncertain', async () => {
    const foreignMeetingId = '66666666-6666-4666-8666-666666666666'
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        ...item,
        meetingId: foreignMeetingId,
        meeting: { ...item.meeting, id: foreignMeetingId },
      },
      meta: {},
      etag: '"action-etag"',
    })

    await expect(
      createAction(
        {
          meetingId: item.meetingId,
          title: item.title,
          details: item.details,
          assigneeUserId: item.assigneeUserId!,
          dueDate: item.dueDate,
        },
        'creation-intent'
      )
    ).rejects.toMatchObject({
      code: 'ACTION_ITEM_CREATION_UNCERTAIN',
      recoveryOutcome: 'uncertain',
    })
  })

  it('serializes every server-side collection parameter', () => {
    expect(
      serializeActionFilter({
        page: 2,
        q: 'launch',
        status: 'OPEN',
        official: true,
        assignee: 'me',
        overdue: true,
        meetingId: item.meetingId,
        sort: 'dueDate,asc',
      })
    ).toEqual({
      page: '2',
      size: '20',
      q: 'launch',
      status: 'OPEN',
      official: 'true',
      assignee: 'me',
      overdue: 'true',
      meetingId: item.meetingId,
      sort: 'dueDate,asc',
    })
  })

  it('uses only meaningful differences and preserves explicit null clears', () => {
    const next: ActionEditValues = {
      title: item.title,
      details: '',
      assigneeUserId: '',
      dueDate: '',
    }
    expect(buildActionPatch(item, next)).toEqual({
      details: null,
      assigneeUserId: null,
      dueDate: null,
    })
  })

  it('rebases only intended edits and preserves concurrent assignment', () => {
    const latest = {
      ...item,
      assigneeUserId: '99999999-9999-4999-8999-999999999999',
    }
    const pending = {
      title: item.title,
      details: '',
      assigneeUserId: item.assigneeUserId!,
      dueDate: '2026-12-31',
    }
    const rebased = rebaseActionDraft(item, latest, pending)
    expect(buildActionPatch(latest, rebased)).toEqual({
      details: null,
      dueDate: '2026-12-31',
    })
    expect(rebased.assigneeUserId).toBe(latest.assigneeUserId)
  })

  it('does not fabricate an empty update', () => {
    expect(
      buildActionPatch(item, {
        title: item.title,
        details: item.details ?? '',
        assigneeUserId: item.assigneeUserId ?? '',
        dueDate: item.dueDate ?? '',
      })
    ).toEqual({})
  })
})
