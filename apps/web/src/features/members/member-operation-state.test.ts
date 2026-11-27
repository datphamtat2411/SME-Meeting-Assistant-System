import { describe, expect, it } from 'vitest'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MemberSnapshot } from './member-api'
import {
  memberOperationReducer,
  selectEditorFeedback,
  selectEditorSession,
  selectOperationCapabilities,
  storeMemberOperationFeedback,
  type MemberAuthorizationContext,
  type MemberOperationState,
} from './member-operation-state'

const actor: AuthContext = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  displayName: 'Administrator',
  globalRole: 'ADMINISTRATOR',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: true, unitIds: [] },
  session: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientType: 'WEB',
    createdAt: '2026-11-24T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-11-24T00:00:00Z',
  },
}

const authorization: MemberAuthorizationContext = {
  actorId: actor.userId,
  sessionId: actor.session.id,
  contextKey: 'admin:session-1',
}

const snapshot: MemberSnapshot = {
  etag: 'W/"member-1"',
  member: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: 'member@example.test',
    displayName: 'Member',
    globalRole: 'EMPLOYEE',
    accountStatus: 'ACTIVE',
    primaryOrgUnitId: null,
    managerScopeUnitIds: [],
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
  },
}

const feedback = storeMemberOperationFeedback({
  outcome: 'uncertain',
  message: 'The outcome could not be confirmed.',
})

function reduce(
  state: MemberOperationState,
  action: Parameters<typeof memberOperationReducer>[1]
) {
  return memberOperationReducer(state, action)
}

describe('Member operation state transitions', () => {
  it('rejects a completion belonging to an obsolete operation', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_CREATE',
        operationId: 1,
        authorization,
      }
    )
    state = reduce(state, {
      type: 'START_CREATE',
      operationId: 2,
      authorization: { ...authorization, contextKey: 'admin:session-2' },
    })

    const next = reduce(state, {
      type: 'SUBMISSION_REJECTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback,
    })

    expect(next).toEqual(state)
  })

  it('does not let an obsolete verification request replace a newer review', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_CREATE',
        operationId: 1,
        authorization,
      }
    )
    state = reduce(state, {
      type: 'SUBMISSION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      payload: {
        email: 'new@example.test',
        displayName: 'New',
      },
    })
    state = reduce(state, {
      type: 'SUBMISSION_UNCERTAIN',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback,
    })
    state = reduce(state, {
      type: 'VERIFICATION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 10,
    })
    state = reduce(state, {
      type: 'VERIFICATION_SUCCEEDED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 10,
      result: {
        kind: 'create',
        reconciliation: {
          status: 'not-found',
          visibilityLimited: false,
        },
        message: 'No match.',
      },
    })
    state = reduce(state, {
      type: 'VERIFICATION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 11,
    })

    const obsolete = reduce(state, {
      type: 'VERIFICATION_SUCCEEDED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 10,
      result: {
        kind: 'create',
        reconciliation: {
          status: 'found',
          member: snapshot.member,
          metadataMatches: false,
          visibilityLimited: false,
        },
        message: 'Found.',
      },
    })
    expect(obsolete).toEqual(state)

    const current = reduce(state, {
      type: 'VERIFICATION_SUCCEEDED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 11,
      result: {
        kind: 'create',
        reconciliation: {
          status: 'not-found',
          visibilityLimited: false,
        },
        message: 'No match on the newer read.',
      },
    })
    expect(current).toMatchObject({
      kind: 'create',
      phase: 'review-not-found',
    })
    expect(selectEditorFeedback(current)?.message).toBe(
      'No match on the newer read.'
    )
  })

  it('only permits a creation draft review after a successful no-match result', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_CREATE',
        operationId: 1,
        authorization,
      }
    )
    state = reduce(state, {
      type: 'SUBMISSION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      payload: { email: 'new@example.test', displayName: 'New' },
    })
    state = reduce(state, {
      type: 'SUBMISSION_UNCERTAIN',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback,
    })
    state = reduce(state, {
      type: 'VERIFICATION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 1,
    })
    const found = reduce(state, {
      type: 'VERIFICATION_SUCCEEDED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 1,
      result: {
        kind: 'create',
        reconciliation: {
          status: 'found',
          member: snapshot.member,
          metadataMatches: true,
          visibilityLimited: false,
        },
        message: 'Found.',
      },
    })
    expect(
      reduce(found, {
        type: 'CREATION_DRAFT_REVIEWED',
        operationId: 1,
        contextKey: authorization.contextKey,
      })
    ).toEqual(found)

    const failed = reduce(state, {
      type: 'VERIFICATION_FAILED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 1,
      error: 'Directory unavailable.',
    })
    expect(
      reduce(failed, {
        type: 'CREATION_DRAFT_REVIEWED',
        operationId: 1,
        contextKey: authorization.contextKey,
      })
    ).toEqual(failed)
  })

  it('blocks edit submission and lifecycle confirmation while verification is required', () => {
    let edit = reduce(
      { kind: 'idle' },
      {
        type: 'START_EDIT',
        operationId: 1,
        authorization,
        memberId: snapshot.member.id,
        requestId: 1,
      }
    )
    edit = reduce(edit, {
      type: 'SNAPSHOT_LOADED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 1,
      snapshot,
    })
    edit = reduce(edit, {
      type: 'SUBMISSION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      payload: { displayName: 'Changed' },
    })
    edit = reduce(edit, {
      type: 'SUBMISSION_UNCERTAIN',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback,
    })
    expect(selectOperationCapabilities(edit).canSubmit).toBe(false)

    let lifecycle = reduce(
      { kind: 'idle' },
      {
        type: 'START_LIFECYCLE',
        operationId: 2,
        authorization,
        memberId: snapshot.member.id,
        action: 'deactivate',
        requestId: 2,
      }
    )
    lifecycle = reduce(lifecycle, {
      type: 'SNAPSHOT_LOADED',
      operationId: 2,
      contextKey: authorization.contextKey,
      requestId: 2,
      snapshot,
    })
    lifecycle = reduce(lifecycle, {
      type: 'SUBMISSION_STARTED',
      operationId: 2,
      contextKey: authorization.contextKey,
    })
    lifecycle = reduce(lifecycle, {
      type: 'SUBMISSION_UNCERTAIN',
      operationId: 2,
      contextKey: authorization.contextKey,
      feedback,
    })
    expect(selectOperationCapabilities(lifecycle).canSubmit).toBe(false)
  })

  it('invalidates completion events when closed or when authorization is replaced', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_EDIT',
        operationId: 1,
        authorization,
        memberId: snapshot.member.id,
        requestId: 1,
      }
    )
    const closed = reduce(state, {
      type: 'OPERATION_CLOSED',
      operationId: 1,
      contextKey: authorization.contextKey,
    })
    expect(closed).toEqual({ kind: 'idle' })
    expect(
      reduce(closed, {
        type: 'SNAPSHOT_LOADED',
        operationId: 1,
        contextKey: authorization.contextKey,
        requestId: 1,
        snapshot,
      })
    ).toEqual(closed)

    state = reduce(
      { kind: 'idle' },
      {
        type: 'START_CREATE',
        operationId: 3,
        authorization,
      }
    )
    expect(
      reduce(state, {
        type: 'AUTHORIZATION_CONTEXT_INVALIDATED',
        contextKey: 'different-context',
      })
    ).toEqual({ kind: 'idle' })
  })

  it('settles an initial snapshot when verification interrupts its response', () => {
    const loading = reduce(
      { kind: 'idle' },
      {
        type: 'START_EDIT',
        operationId: 1,
        authorization,
        memberId: snapshot.member.id,
        requestId: 4,
      }
    )

    const deferred = reduce(loading, {
      type: 'SNAPSHOT_DEFERRED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 4,
      message: 'Verification is required before reviewing this member.',
    })

    expect(deferred).toMatchObject({
      kind: 'edit',
      phase: 'load-error',
      loadError: 'Verification is required before reviewing this member.',
    })
    expect(selectEditorSession(deferred)).toMatchObject({ status: 'error' })
  })

  it('returns recovery verification to an explicit retry phase when authorization is unavailable', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_CREATE',
        operationId: 1,
        authorization,
      }
    )
    state = reduce(state, {
      type: 'SUBMISSION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      payload: { email: 'new@example.test', displayName: 'New' },
    })
    state = reduce(state, {
      type: 'SUBMISSION_UNCERTAIN',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback,
    })
    state = reduce(state, {
      type: 'VERIFICATION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 9,
    })

    const deferred = reduce(state, {
      type: 'VERIFICATION_DEFERRED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 9,
      message: 'Verify access before reviewing the request outcome.',
    })

    expect(deferred).toMatchObject({
      kind: 'create',
      phase: 'verification-required',
      feedback: {
        message: 'Verify access before reviewing the request outcome.',
      },
    })
    expect(selectOperationCapabilities(deferred)).toMatchObject({
      canRetryVerification: true,
      canSubmit: false,
    })
  })

  it('keeps a rejected edit editable with its submitted draft and reviewed snapshot', () => {
    let state = reduce(
      { kind: 'idle' },
      {
        type: 'START_EDIT',
        operationId: 1,
        authorization,
        memberId: snapshot.member.id,
        requestId: 1,
      }
    )
    state = reduce(state, {
      type: 'SNAPSHOT_LOADED',
      operationId: 1,
      contextKey: authorization.contextKey,
      requestId: 1,
      snapshot,
    })
    state = reduce(state, {
      type: 'SUBMISSION_STARTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      payload: { displayName: 'Retained draft' },
    })
    state = reduce(state, {
      type: 'SUBMISSION_REJECTED',
      operationId: 1,
      contextKey: authorization.contextKey,
      feedback: storeMemberOperationFeedback({
        outcome: 'rejected',
        message: 'The update was rejected.',
      }),
    })

    expect(selectOperationCapabilities(state).canSubmit).toBe(true)
    expect(selectEditorSession(state)).toMatchObject({
      status: 'ready',
      snapshot,
    })
    expect(selectEditorFeedback(state)).toMatchObject({
      submittedPatch: { displayName: 'Retained draft' },
      message: 'The update was rejected.',
    })
  })
})
