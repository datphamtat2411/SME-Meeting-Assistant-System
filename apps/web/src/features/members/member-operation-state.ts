import type { MemberLifecycleAction } from './member-administration-policy'
import type {
  Member,
  MemberCreatePayload,
  MemberCreationReconciliation,
  MemberPatchPayload,
  MemberSnapshot,
} from './member-api'
import type { MemberFormValues } from './member-form'
import type {
  MemberEditReconciliation,
  MemberEditableValues,
} from './member-reconciliation'

export type MemberOperationOutcome =
  | 'rejected'
  | 'precondition'
  | 'uncertain'
  | 'unknown'

/**
 * The values below are presentation data derived from the operation phase.
 * `latestSnapshot`, `creationReconciliation`, and `editReconciliation` are
 * populated by the selectors from the phase-specific state; they are not
 * independent recovery state.
 */
export interface MemberOperationFeedback {
  outcome: MemberOperationOutcome
  message: string
  fieldErrors?: Record<string, string[]>
  latestSnapshot?: MemberSnapshot
  originalSnapshot?: MemberSnapshot
  submittedPatch?: MemberPatchPayload
  submittedCreationPayload?: MemberCreatePayload
  creationReconciliation?: MemberCreationReconciliation
  editReconciliation?: MemberEditReconciliation
  latestMatchesRequest?: boolean
  reconciliationError?: string
  reconciliationLoading?: boolean
}

export type MemberStoredFeedback = Omit<
  MemberOperationFeedback,
  | 'latestSnapshot'
  | 'originalSnapshot'
  | 'submittedPatch'
  | 'submittedCreationPayload'
  | 'creationReconciliation'
  | 'editReconciliation'
  | 'latestMatchesRequest'
  | 'reconciliationLoading'
>

export interface MemberAuthorizationContext {
  actorId: string
  sessionId: string
  contextKey: string
}

interface OperationIdentity {
  operationId: number
  authorization: MemberAuthorizationContext
}

type CreateReadyOperation = OperationIdentity & {
  kind: 'create'
  phase: 'ready'
  draft?: MemberCreatePayload
}

type CreateSubmittingOperation = OperationIdentity & {
  kind: 'create'
  phase: 'submitting'
  submittedPayload: MemberCreatePayload
}

type CreateRecoveryOperation = OperationIdentity & {
  kind: 'create'
  submittedPayload: MemberCreatePayload
  feedback: MemberStoredFeedback
}

export type CreateOperation =
  | CreateReadyOperation
  | CreateSubmittingOperation
  | (CreateRecoveryOperation & { phase: 'rejected' })
  | (CreateRecoveryOperation & { phase: 'verification-required' })
  | (CreateRecoveryOperation & {
      phase: 'verifying'
      verificationRequestId: number
    })
  | (CreateRecoveryOperation & {
      phase: 'review-found'
      reconciliation: Extract<MemberCreationReconciliation, { status: 'found' }>
    })
  | (CreateRecoveryOperation & {
      phase: 'review-not-found'
      reconciliation: Extract<
        MemberCreationReconciliation,
        { status: 'not-found' }
      >
    })
  | (CreateRecoveryOperation & {
      phase: 'verification-failed'
      verificationError: string
    })

type EditBaseOperation = OperationIdentity & {
  kind: 'edit'
  memberId: string
}

export type EditOperation =
  | (EditBaseOperation & {
      phase: 'loading'
      snapshotRequestId: number
    })
  | (EditBaseOperation & {
      phase: 'load-error'
      loadError: string
    })
  | (EditBaseOperation & {
      phase: 'ready'
      reviewedSnapshot: MemberSnapshot
      initialValues?: MemberFormValues
    })
  | (EditBaseOperation & {
      phase: 'submitting'
      reviewedSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
    })
  | (EditBaseOperation & {
      phase: 'rejected'
      reviewedSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
      feedback: MemberStoredFeedback
    })
  | (EditBaseOperation & {
      phase: 'verification-required'
      originalSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
      feedback: MemberStoredFeedback
    })
  | (EditBaseOperation & {
      phase: 'verifying'
      originalSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
      feedback: MemberStoredFeedback
      verificationRequestId: number
    })
  | (EditBaseOperation & {
      phase: 'review'
      originalSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
      latestSnapshot: MemberSnapshot
      reconciliation: MemberEditReconciliation
      latestMatchesRequest: boolean
      feedback: MemberStoredFeedback
    })
  | (EditBaseOperation & {
      phase: 'verification-failed'
      originalSnapshot: MemberSnapshot
      submittedPatch: MemberPatchPayload
      feedback: MemberStoredFeedback
      verificationError: string
    })

export type LifecycleRecoveryClassification =
  | 'desired-state-present'
  | 'outcome-inconclusive'
  | 'eligible-renewed-review'
  | 'ineligible'

type LifecycleBaseOperation = OperationIdentity & {
  kind: 'lifecycle'
  memberId: string
  action: MemberLifecycleAction
}

export type LifecycleOperation =
  | (LifecycleBaseOperation & {
      phase: 'loading'
      snapshotRequestId: number
    })
  | (LifecycleBaseOperation & {
      phase: 'load-error'
      loadError: string
    })
  | (LifecycleBaseOperation & {
      phase: 'confirm'
      reviewedSnapshot: MemberSnapshot
    })
  | (LifecycleBaseOperation & {
      phase: 'submitting'
      reviewedSnapshot: MemberSnapshot
    })
  | (LifecycleBaseOperation & {
      phase: 'rejected'
      reviewedSnapshot: MemberSnapshot
      feedback: MemberStoredFeedback
    })
  | (LifecycleBaseOperation & {
      phase: 'verification-required'
      originalSnapshot: MemberSnapshot
      feedback: MemberStoredFeedback
    })
  | (LifecycleBaseOperation & {
      phase: 'verifying'
      originalSnapshot: MemberSnapshot
      feedback: MemberStoredFeedback
      verificationRequestId: number
    })
  | (LifecycleBaseOperation & {
      phase: 'review'
      originalSnapshot: MemberSnapshot
      latestSnapshot: MemberSnapshot
      latestVerifiedState: Member['accountStatus']
      desiredStatePresent: boolean
      eligible: boolean
      classification: LifecycleRecoveryClassification
      feedback: MemberStoredFeedback
    })
  | (LifecycleBaseOperation & {
      phase: 'verification-failed'
      originalSnapshot: MemberSnapshot
      feedback: MemberStoredFeedback
      verificationError: string
    })

export type MemberOperationState =
  | { kind: 'idle' }
  | CreateOperation
  | EditOperation
  | LifecycleOperation

export type MemberOperationAction =
  | {
      type: 'START_CREATE'
      operationId: number
      authorization: MemberAuthorizationContext
    }
  | {
      type: 'START_EDIT'
      operationId: number
      authorization: MemberAuthorizationContext
      memberId: string
      requestId: number
    }
  | {
      type: 'START_LIFECYCLE'
      operationId: number
      authorization: MemberAuthorizationContext
      memberId: string
      action: MemberLifecycleAction
      requestId: number
    }
  | {
      type: 'SNAPSHOT_REQUESTED'
      operationId: number
      contextKey: string
      requestId: number
    }
  | {
      type: 'SNAPSHOT_LOADED'
      operationId: number
      contextKey: string
      requestId: number
      snapshot: MemberSnapshot
    }
  | {
      type: 'SNAPSHOT_FAILED'
      operationId: number
      contextKey: string
      requestId: number
      error: string
    }
  | {
      type: 'SNAPSHOT_DEFERRED'
      operationId: number
      contextKey: string
      requestId: number
      message: string
    }
  | {
      type: 'SUBMISSION_STARTED'
      operationId: number
      contextKey: string
      payload?: MemberCreatePayload | MemberPatchPayload
    }
  | {
      type: 'SUBMISSION_REJECTED'
      operationId: number
      contextKey: string
      feedback: MemberStoredFeedback
    }
  | {
      type: 'SUBMISSION_UNCERTAIN'
      operationId: number
      contextKey: string
      feedback: MemberStoredFeedback
    }
  | {
      type: 'SUBMISSION_CONFIRMED'
      operationId: number
      contextKey: string
    }
  | {
      type: 'VERIFICATION_STARTED'
      operationId: number
      contextKey: string
      requestId: number
    }
  | {
      type: 'VERIFICATION_SUCCEEDED'
      operationId: number
      contextKey: string
      requestId: number
      result:
        | {
            kind: 'create'
            reconciliation: MemberCreationReconciliation
            message: string
          }
        | {
            kind: 'edit'
            latestSnapshot: MemberSnapshot
            reconciliation: MemberEditReconciliation
            latestMatchesRequest: boolean
            message: string
          }
        | {
            kind: 'lifecycle'
            latestSnapshot: MemberSnapshot
            desiredStatePresent: boolean
            eligible: boolean
            classification: LifecycleRecoveryClassification
            message: string
          }
    }
  | {
      type: 'VERIFICATION_FAILED'
      operationId: number
      contextKey: string
      requestId: number
      error: string
    }
  | {
      type: 'VERIFICATION_DEFERRED'
      operationId: number
      contextKey: string
      requestId: number
      message: string
    }
  | {
      type: 'CREATION_DRAFT_REVIEWED'
      operationId: number
      contextKey: string
    }
  | {
      type: 'EDIT_RECONCILIATION_RESOLVED'
      operationId: number
      contextKey: string
      reviewedVersion: string
      nextOperationId: number
      values: MemberEditableValues
    }
  | {
      type: 'EDIT_DISCARDED'
      operationId: number
      contextKey: string
      reviewedVersion: string
      nextOperationId: number
    }
  | {
      type: 'RECOVERY_VALIDATION_FAILED'
      operationId: number
      contextKey: string
      reviewedVersion: string
      message: string
    }
  | {
      type: 'LIFECYCLE_REVIEW_CONFIRMED'
      operationId: number
      contextKey: string
      reviewedVersion: string
      nextOperationId: number
    }
  | {
      type: 'OPERATION_CLOSED'
      operationId: number
      contextKey: string
    }
  | {
      type: 'AUTHORIZATION_CONTEXT_INVALIDATED'
      contextKey: string
    }

function matches(
  state: MemberOperationState,
  operationId: number,
  contextKey: string
): state is Exclude<MemberOperationState, { kind: 'idle' }> {
  return (
    state.kind !== 'idle' &&
    state.operationId === operationId &&
    state.authorization.contextKey === contextKey
  )
}

function isEditSnapshotRequest(
  state: MemberOperationState
): state is Extract<EditOperation, { phase: 'loading' | 'load-error' }> {
  return (
    state.kind === 'edit' &&
    (state.phase === 'loading' || state.phase === 'load-error')
  )
}

function isLifecycleSnapshotRequest(
  state: MemberOperationState
): state is Extract<LifecycleOperation, { phase: 'loading' | 'load-error' }> {
  return (
    state.kind === 'lifecycle' &&
    (state.phase === 'loading' || state.phase === 'load-error')
  )
}

export function storeMemberOperationFeedback(
  feedback: MemberOperationFeedback
): MemberStoredFeedback {
  const {
    latestSnapshot: _latestSnapshot,
    originalSnapshot: _originalSnapshot,
    submittedPatch: _submittedPatch,
    submittedCreationPayload: _submittedCreationPayload,
    creationReconciliation: _creationReconciliation,
    editReconciliation: _editReconciliation,
    latestMatchesRequest: _latestMatchesRequest,
    reconciliationLoading: _reconciliationLoading,
    ...stored
  } = feedback
  return stored
}

export function memberOperationReducer(
  state: MemberOperationState,
  action: MemberOperationAction
): MemberOperationState {
  switch (action.type) {
    case 'START_CREATE':
      return {
        kind: 'create',
        phase: 'ready',
        operationId: action.operationId,
        authorization: action.authorization,
      }
    case 'START_EDIT':
      return {
        kind: 'edit',
        phase: 'loading',
        operationId: action.operationId,
        authorization: action.authorization,
        memberId: action.memberId,
        snapshotRequestId: action.requestId,
      }
    case 'START_LIFECYCLE':
      return {
        kind: 'lifecycle',
        phase: 'loading',
        operationId: action.operationId,
        authorization: action.authorization,
        memberId: action.memberId,
        action: action.action,
        snapshotRequestId: action.requestId,
      }
    case 'SNAPSHOT_REQUESTED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (isEditSnapshotRequest(state)) {
        return {
          ...state,
          phase: 'loading',
          snapshotRequestId: action.requestId,
        }
      }
      if (isLifecycleSnapshotRequest(state)) {
        return {
          ...state,
          phase: 'loading',
          snapshotRequestId: action.requestId,
        }
      }
      return state
    case 'SNAPSHOT_LOADED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'edit' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return {
          kind: 'edit',
          phase: 'ready',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          reviewedSnapshot: action.snapshot,
        }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return {
          kind: 'lifecycle',
          phase: 'confirm',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          action: state.action,
          reviewedSnapshot: action.snapshot,
        }
      }
      return state
    case 'SNAPSHOT_FAILED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'edit' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return { ...state, phase: 'load-error', loadError: action.error }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return { ...state, phase: 'load-error', loadError: action.error }
      }
      return state
    case 'SNAPSHOT_DEFERRED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'edit' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return { ...state, phase: 'load-error', loadError: action.message }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'loading' &&
        state.snapshotRequestId === action.requestId
      ) {
        return { ...state, phase: 'load-error', loadError: action.message }
      }
      return state
    case 'SUBMISSION_STARTED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'create' &&
        (state.phase === 'ready' || state.phase === 'rejected') &&
        action.payload &&
        'email' in action.payload
      ) {
        return {
          kind: 'create',
          phase: 'submitting',
          operationId: state.operationId,
          authorization: state.authorization,
          submittedPayload: action.payload,
        }
      }
      if (
        state.kind === 'edit' &&
        (state.phase === 'ready' || state.phase === 'rejected') &&
        action.payload &&
        !('email' in action.payload)
      ) {
        return {
          kind: 'edit',
          phase: 'submitting',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          reviewedSnapshot: state.reviewedSnapshot,
          submittedPatch: action.payload,
        }
      }
      if (
        state.kind === 'lifecycle' &&
        (state.phase === 'confirm' || state.phase === 'rejected')
      ) {
        return {
          kind: 'lifecycle',
          phase: 'submitting',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          action: state.action,
          reviewedSnapshot: state.reviewedSnapshot,
        }
      }
      return state
    case 'SUBMISSION_REJECTED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (state.kind === 'create' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'rejected',
          feedback: action.feedback,
        }
      }
      if (state.kind === 'edit' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'rejected',
          feedback: action.feedback,
        }
      }
      if (state.kind === 'lifecycle' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'rejected',
          feedback: action.feedback,
        }
      }
      return state
    case 'SUBMISSION_UNCERTAIN':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (state.kind === 'create' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'verification-required',
          feedback: action.feedback,
        }
      }
      if (state.kind === 'edit' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'verification-required',
          originalSnapshot: state.reviewedSnapshot,
          feedback: action.feedback,
        }
      }
      if (state.kind === 'lifecycle' && state.phase === 'submitting') {
        return {
          ...state,
          phase: 'verification-required',
          originalSnapshot: state.reviewedSnapshot,
          feedback: action.feedback,
        }
      }
      return state
    case 'SUBMISSION_CONFIRMED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      return state.phase === 'submitting' ? { kind: 'idle' } : state
    case 'VERIFICATION_STARTED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'create' &&
        (state.phase === 'verification-required' ||
          state.phase === 'verification-failed' ||
          state.phase === 'review-found' ||
          state.phase === 'review-not-found')
      ) {
        return {
          ...state,
          phase: 'verifying',
          verificationRequestId: action.requestId,
        }
      }
      if (
        state.kind === 'edit' &&
        (state.phase === 'verification-required' ||
          state.phase === 'verification-failed' ||
          state.phase === 'review')
      ) {
        return {
          kind: 'edit',
          phase: 'verifying',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          originalSnapshot:
            state.phase === 'review'
              ? state.originalSnapshot
              : state.originalSnapshot,
          submittedPatch: state.submittedPatch,
          feedback: state.feedback,
          verificationRequestId: action.requestId,
        }
      }
      if (
        state.kind === 'lifecycle' &&
        (state.phase === 'verification-required' ||
          state.phase === 'verification-failed' ||
          state.phase === 'review')
      ) {
        return {
          kind: 'lifecycle',
          phase: 'verifying',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          action: state.action,
          originalSnapshot: state.originalSnapshot,
          feedback: state.feedback,
          verificationRequestId: action.requestId,
        }
      }
      return state
    case 'VERIFICATION_SUCCEEDED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'create' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId &&
        action.result.kind === 'create'
      ) {
        return action.result.reconciliation.status === 'found'
          ? {
              ...state,
              phase: 'review-found',
              reconciliation: action.result.reconciliation,
              feedback: {
                outcome: state.feedback.outcome,
                message: action.result.message,
                ...(state.feedback.fieldErrors
                  ? { fieldErrors: state.feedback.fieldErrors }
                  : {}),
              },
            }
          : {
              ...state,
              phase: 'review-not-found',
              reconciliation: action.result.reconciliation,
              feedback: {
                outcome: state.feedback.outcome,
                message: action.result.message,
                ...(state.feedback.fieldErrors
                  ? { fieldErrors: state.feedback.fieldErrors }
                  : {}),
              },
            }
      }
      if (
        state.kind === 'edit' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId &&
        action.result.kind === 'edit'
      ) {
        return {
          kind: 'edit',
          phase: 'review',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          originalSnapshot: state.originalSnapshot,
          submittedPatch: state.submittedPatch,
          latestSnapshot: action.result.latestSnapshot,
          reconciliation: action.result.reconciliation,
          latestMatchesRequest: action.result.latestMatchesRequest,
          feedback: {
            outcome: state.feedback.outcome,
            message: action.result.message,
            ...(state.feedback.fieldErrors
              ? { fieldErrors: state.feedback.fieldErrors }
              : {}),
          },
        }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId &&
        action.result.kind === 'lifecycle'
      ) {
        return {
          kind: 'lifecycle',
          phase: 'review',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          action: state.action,
          originalSnapshot: state.originalSnapshot,
          latestSnapshot: action.result.latestSnapshot,
          latestVerifiedState:
            action.result.latestSnapshot.member.accountStatus,
          desiredStatePresent: action.result.desiredStatePresent,
          eligible: action.result.eligible,
          classification: action.result.classification,
          feedback: {
            outcome: state.feedback.outcome,
            message: action.result.message,
            ...(state.feedback.fieldErrors
              ? { fieldErrors: state.feedback.fieldErrors }
              : {}),
          },
        }
      }
      return state
    case 'VERIFICATION_FAILED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'create' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          ...state,
          phase: 'verification-failed',
          verificationError: action.error,
        }
      }
      if (
        state.kind === 'edit' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          kind: 'edit',
          phase: 'verification-failed',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          originalSnapshot: state.originalSnapshot,
          submittedPatch: state.submittedPatch,
          feedback: state.feedback,
          verificationError: action.error,
        }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          kind: 'lifecycle',
          phase: 'verification-failed',
          operationId: state.operationId,
          authorization: state.authorization,
          memberId: state.memberId,
          action: state.action,
          originalSnapshot: state.originalSnapshot,
          feedback: state.feedback,
          verificationError: action.error,
        }
      }
      return state
    case 'VERIFICATION_DEFERRED':
      if (!matches(state, action.operationId, action.contextKey)) return state
      if (
        state.kind === 'create' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          ...state,
          phase: 'verification-required',
          feedback: { ...state.feedback, message: action.message },
        }
      }
      if (
        state.kind === 'edit' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          ...state,
          phase: 'verification-required',
          feedback: { ...state.feedback, message: action.message },
        }
      }
      if (
        state.kind === 'lifecycle' &&
        state.phase === 'verifying' &&
        state.verificationRequestId === action.requestId
      ) {
        return {
          ...state,
          phase: 'verification-required',
          feedback: { ...state.feedback, message: action.message },
        }
      }
      return state
    case 'CREATION_DRAFT_REVIEWED':
      if (
        !matches(state, action.operationId, action.contextKey) ||
        state.kind !== 'create' ||
        state.phase !== 'review-not-found'
      ) {
        return state
      }
      return {
        kind: 'create',
        phase: 'ready',
        operationId: state.operationId,
        authorization: state.authorization,
        draft: state.submittedPayload,
      }
    case 'EDIT_RECONCILIATION_RESOLVED':
      if (
        !matches(state, action.operationId, action.contextKey) ||
        state.kind !== 'edit' ||
        state.phase !== 'review' ||
        state.latestSnapshot.etag !== action.reviewedVersion
      ) {
        return state
      }
      return {
        kind: 'edit',
        phase: 'ready',
        operationId: action.nextOperationId,
        authorization: state.authorization,
        memberId: state.memberId,
        reviewedSnapshot: state.latestSnapshot,
        initialValues: {
          email: state.latestSnapshot.member.email,
          displayName: action.values.displayName,
          primaryOrgUnitId: action.values.primaryOrgUnitId ?? '',
          globalRole: action.values.globalRole,
          managerScopeUnitIds: action.values.managerScopeUnitIds,
        },
      }
    case 'EDIT_DISCARDED':
      if (
        !matches(state, action.operationId, action.contextKey) ||
        state.kind !== 'edit' ||
        state.phase !== 'review' ||
        state.latestSnapshot.etag !== action.reviewedVersion
      ) {
        return state
      }
      return {
        kind: 'edit',
        phase: 'ready',
        operationId: action.nextOperationId,
        authorization: state.authorization,
        memberId: state.memberId,
        reviewedSnapshot: state.latestSnapshot,
      }
    case 'RECOVERY_VALIDATION_FAILED':
      if (
        !matches(state, action.operationId, action.contextKey) ||
        state.kind !== 'edit' ||
        state.phase !== 'review' ||
        state.latestSnapshot.etag !== action.reviewedVersion
      ) {
        return state
      }
      return {
        ...state,
        feedback: {
          ...state.feedback,
          reconciliationError: action.message,
        },
      }
    case 'LIFECYCLE_REVIEW_CONFIRMED':
      if (
        !matches(state, action.operationId, action.contextKey) ||
        state.kind !== 'lifecycle' ||
        state.phase !== 'review' ||
        state.latestSnapshot.etag !== action.reviewedVersion ||
        !state.eligible ||
        state.desiredStatePresent
      ) {
        return state
      }
      return {
        kind: 'lifecycle',
        phase: 'confirm',
        operationId: action.nextOperationId,
        authorization: state.authorization,
        memberId: state.memberId,
        action: state.action,
        reviewedSnapshot: state.latestSnapshot,
      }
    case 'OPERATION_CLOSED':
      return matches(state, action.operationId, action.contextKey)
        ? { kind: 'idle' }
        : state
    case 'AUTHORIZATION_CONTEXT_INVALIDATED':
      return state.kind !== 'idle' &&
        state.authorization.contextKey !== action.contextKey
        ? { kind: 'idle' }
        : state
  }
}

export type MemberEditorSession =
  | {
      operationId: number
      contextKey: string
      mode: 'create'
      phase: CreateOperation['phase']
      status: 'ready'
      draft?: MemberCreatePayload
    }
  | {
      operationId: number
      contextKey: string
      mode: 'edit'
      memberId: string
      phase: EditOperation['phase']
      status: 'loading' | 'error' | 'ready'
      snapshot?: MemberSnapshot
      initialValues?: MemberFormValues
      loadError?: string
    }

export type MemberLifecycleSession = {
  operationId: number
  contextKey: string
  memberId: string
  action: MemberLifecycleAction
  phase: LifecycleOperation['phase']
  status: 'loading' | 'error' | 'confirm'
  snapshot?: MemberSnapshot
  loadError?: string
}

function editorSnapshot(operation: EditOperation): MemberSnapshot | undefined {
  switch (operation.phase) {
    case 'ready':
    case 'submitting':
    case 'rejected':
      return operation.reviewedSnapshot
    case 'review':
      return operation.latestSnapshot
    case 'verification-required':
    case 'verifying':
    case 'verification-failed':
      return operation.originalSnapshot
    case 'loading':
    case 'load-error':
      return undefined
  }
}

function lifecycleSnapshot(
  operation: LifecycleOperation
): MemberSnapshot | undefined {
  switch (operation.phase) {
    case 'confirm':
    case 'submitting':
    case 'rejected':
      return operation.reviewedSnapshot
    case 'review':
      return operation.latestSnapshot
    case 'verification-required':
    case 'verifying':
    case 'verification-failed':
      return operation.originalSnapshot
    case 'loading':
    case 'load-error':
      return undefined
  }
}

export function selectEditorSession(
  state: MemberOperationState
): MemberEditorSession | null {
  if (state.kind === 'create') {
    return {
      operationId: state.operationId,
      contextKey: state.authorization.contextKey,
      mode: 'create',
      phase: state.phase,
      status: 'ready',
      ...(state.phase === 'ready' && state.draft ? { draft: state.draft } : {}),
    }
  }
  if (state.kind !== 'edit') return null
  return {
    operationId: state.operationId,
    contextKey: state.authorization.contextKey,
    mode: 'edit',
    memberId: state.memberId,
    phase: state.phase,
    status:
      state.phase === 'loading'
        ? 'loading'
        : state.phase === 'load-error'
          ? 'error'
          : 'ready',
    ...(editorSnapshot(state) ? { snapshot: editorSnapshot(state) } : {}),
    ...(state.phase === 'ready' && state.initialValues
      ? { initialValues: state.initialValues }
      : {}),
    ...(state.phase === 'load-error' ? { loadError: state.loadError } : {}),
  }
}

export function selectLifecycleSession(
  state: MemberOperationState
): MemberLifecycleSession | null {
  if (state.kind !== 'lifecycle') return null
  const snapshot = lifecycleSnapshot(state)
  return {
    operationId: state.operationId,
    contextKey: state.authorization.contextKey,
    memberId: state.memberId,
    action: state.action,
    phase: state.phase,
    status:
      state.phase === 'loading'
        ? 'loading'
        : state.phase === 'load-error'
          ? 'error'
          : 'confirm',
    ...(snapshot ? { snapshot } : {}),
    ...(state.phase === 'load-error' ? { loadError: state.loadError } : {}),
  }
}

export function selectEditorFeedback(
  state: MemberOperationState
): MemberOperationFeedback | null {
  if (state.kind === 'create') {
    if (state.phase === 'ready' || state.phase === 'submitting') {
      return null
    }
    const feedback = 'feedback' in state ? state.feedback : undefined
    if (!feedback) return null
    return {
      ...feedback,
      submittedCreationPayload: state.submittedPayload,
      ...(state.phase === 'review-found' || state.phase === 'review-not-found'
        ? { creationReconciliation: state.reconciliation }
        : {}),
      ...(state.phase === 'verifying' ? { reconciliationLoading: true } : {}),
      ...(state.phase === 'verification-failed'
        ? {
            reconciliationError: state.verificationError,
            reconciliationLoading: false,
          }
        : {}),
    }
  }
  if (state.kind !== 'edit') return null
  if (
    state.phase === 'loading' ||
    state.phase === 'load-error' ||
    state.phase === 'ready' ||
    state.phase === 'submitting'
  ) {
    return null
  }
  return {
    ...state.feedback,
    originalSnapshot:
      state.phase === 'review' ||
      state.phase === 'verification-failed' ||
      state.phase === 'verifying' ||
      state.phase === 'verification-required'
        ? state.originalSnapshot
        : state.reviewedSnapshot,
    submittedPatch: state.submittedPatch,
    ...(state.phase === 'review'
      ? {
          latestSnapshot: state.latestSnapshot,
          editReconciliation: state.reconciliation,
          latestMatchesRequest: state.latestMatchesRequest,
        }
      : {}),
    ...(state.phase === 'verifying' ? { reconciliationLoading: true } : {}),
    ...(state.phase === 'verification-failed'
      ? {
          reconciliationError: state.verificationError,
          reconciliationLoading: false,
        }
      : {}),
  }
}

export function selectLifecycleFeedback(
  state: MemberOperationState
): MemberOperationFeedback | null {
  if (state.kind !== 'lifecycle') return null
  if (
    state.phase === 'loading' ||
    state.phase === 'load-error' ||
    state.phase === 'confirm' ||
    state.phase === 'submitting'
  ) {
    return null
  }
  return {
    ...state.feedback,
    ...(state.phase === 'review'
      ? { latestSnapshot: state.latestSnapshot }
      : {}),
    ...(state.phase === 'verifying' ? { reconciliationLoading: true } : {}),
    ...(state.phase === 'verification-failed'
      ? {
          reconciliationError: state.verificationError,
          reconciliationLoading: false,
        }
      : {}),
  }
}

interface MemberOperationCapabilities {
  canSubmit: boolean
  canRetryVerification: boolean
  canReviewCreationDraft: boolean
  canResolveEdit: boolean
  canDiscardAndRestart: boolean
  canRenewLifecycleConfirmation: boolean
  isSubmitting: boolean
  isVerifying: boolean
}

export function selectOperationCapabilities(
  state: MemberOperationState
): MemberOperationCapabilities {
  const empty: MemberOperationCapabilities = {
    canSubmit: false,
    canRetryVerification: false,
    canReviewCreationDraft: false,
    canResolveEdit: false,
    canDiscardAndRestart: false,
    canRenewLifecycleConfirmation: false,
    isSubmitting: false,
    isVerifying: false,
  }
  if (state.kind === 'idle') return empty
  if (state.kind === 'create') {
    return {
      ...empty,
      canSubmit: state.phase === 'ready' || state.phase === 'rejected',
      canRetryVerification:
        state.phase === 'verification-required' ||
        state.phase === 'verification-failed' ||
        state.phase === 'review-found' ||
        state.phase === 'review-not-found',
      canReviewCreationDraft: state.phase === 'review-not-found',
      isSubmitting: state.phase === 'submitting',
      isVerifying: state.phase === 'verifying',
    }
  }
  if (state.kind === 'edit') {
    return {
      ...empty,
      canSubmit: state.phase === 'ready' || state.phase === 'rejected',
      canRetryVerification:
        state.phase === 'verification-required' ||
        state.phase === 'verification-failed' ||
        state.phase === 'review',
      canResolveEdit: state.phase === 'review',
      canDiscardAndRestart: state.phase === 'review',
      isSubmitting: state.phase === 'submitting',
      isVerifying: state.phase === 'verifying',
    }
  }
  return {
    ...empty,
    canSubmit: state.phase === 'confirm' || state.phase === 'rejected',
    canRetryVerification:
      state.phase === 'verification-required' ||
      state.phase === 'verification-failed' ||
      state.phase === 'review',
    canRenewLifecycleConfirmation:
      state.phase === 'review' && state.eligible && !state.desiredStatePresent,
    isSubmitting: state.phase === 'submitting',
    isVerifying: state.phase === 'verifying',
  }
}
