import { normalizeCoreApiError } from '@/lib/core-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import {
  canPerformMemberLifecycle,
  type MemberLifecycleAction,
} from './member-administration-policy'
import { memberDetail, type MemberSnapshot } from './member-api'
import type {
  MemberOperationRequest,
  MemberOperationRequestCoordinator,
} from './member-operation-requests'
import type {
  LifecycleRecoveryClassification,
  MemberOperationAction,
} from './member-operation-state'

interface MemberLifecycleRecoveryDependencies {
  requests: MemberOperationRequestCoordinator
  dispatch: (action: MemberOperationAction) => void
  getIdentity: () => AuthContext | undefined
  isAuthorizationAllowed: (contextKey: string) => boolean
  isOperationCurrent: (operationId: number, contextKey: string) => boolean
}

interface LifecycleVerificationResult {
  latestSnapshot: MemberSnapshot
  desiredStatePresent: boolean
  eligible: boolean
  classification: LifecycleRecoveryClassification
  message: string
}

function desiredStatePresent(
  action: MemberLifecycleAction,
  snapshot: MemberSnapshot
): boolean {
  if (action === 'deactivate') {
    return snapshot.member.accountStatus === 'INACTIVE'
  }
  if (action === 'reactivate') {
    return snapshot.member.accountStatus === 'ACTIVE'
  }
  return false
}

function setupReissueMessage(snapshot: MemberSnapshot): string {
  if (snapshot.member.accountStatus === 'PENDING_SETUP') {
    return 'The account remains pending secure setup. Available account metadata cannot confirm whether the previous reissue request was applied or whether a setup email was delivered; it cannot independently establish whether the previous reissue was applied or whether a setup email was delivered.'
  }
  if (snapshot.member.accountStatus === 'ACTIVE') {
    return 'The latest account state is active. Initial account setup reissue is no longer available. The previous reissue outcome cannot be independently established from the available account metadata.'
  }
  return 'The latest account state is inactive. Initial account setup reissue is not available in this state. The previous reissue outcome remains unconfirmed.'
}

function lifecycleVerification(
  action: MemberLifecycleAction,
  snapshot: MemberSnapshot,
  identity: AuthContext | undefined
): LifecycleVerificationResult {
  const status = snapshot.member.accountStatus
  const desired = desiredStatePresent(action, snapshot)
  const eligible =
    identity !== undefined &&
    canPerformMemberLifecycle(identity, snapshot.member, action)

  if (action === 'account-setup/reissue') {
    return {
      latestSnapshot: snapshot,
      desiredStatePresent: desired,
      eligible,
      classification:
        status === 'PENDING_SETUP' && eligible
          ? 'outcome-inconclusive'
          : 'ineligible',
      message: setupReissueMessage(snapshot),
    }
  }

  if (desired) {
    const label = action === 'deactivate' ? 'inactive' : 'active'
    return {
      latestSnapshot: snapshot,
      desiredStatePresent: true,
      eligible: false,
      classification: 'desired-state-present',
      message: `The server currently verifies this account as ${label}. We cannot determine whether this request caused that state; no second request was sent.`,
    }
  }

  if (eligible) {
    const label = action === 'deactivate' ? 'active' : 'inactive'
    const requested = action === 'deactivate' ? 'deactivation' : 'reactivation'
    return {
      latestSnapshot: snapshot,
      desiredStatePresent: false,
      eligible: true,
      classification: 'eligible-renewed-review',
      message: `The server currently verifies this account as ${label}. The previous ${requested} outcome remains unconfirmed; review this current version before deciding whether to confirm another request.`,
    }
  }

  const stateLabel =
    status === 'ACTIVE'
      ? 'active'
      : status === 'INACTIVE'
        ? 'inactive'
        : 'pending secure setup'
  return {
    latestSnapshot: snapshot,
    desiredStatePresent: false,
    eligible: false,
    classification: 'ineligible',
    message: `The latest account state is ${stateLabel}. This lifecycle operation is no longer eligible for the current account or member state; the previous outcome remains unconfirmed.`,
  }
}

export function classifyMemberLifecycleVerification(
  action: MemberLifecycleAction,
  snapshot: MemberSnapshot,
  identity: AuthContext | undefined
): LifecycleVerificationResult {
  return lifecycleVerification(action, snapshot, identity)
}

interface MemberLifecycleRecovery {
  verifyLifecycle(input: {
    operationId: number
    contextKey: string
    action: MemberLifecycleAction
    originalSnapshot: MemberSnapshot
  }): Promise<void>
}

export function createMemberLifecycleRecovery(
  dependencies: MemberLifecycleRecoveryDependencies
): MemberLifecycleRecovery {
  function canApply(
    request: MemberOperationRequest,
    operationId: number,
    contextKey: string
  ): boolean {
    return (
      dependencies.requests.isCurrentRequest(request, {
        operationId,
        contextKey,
      }) &&
      dependencies.isOperationCurrent(operationId, contextKey) &&
      dependencies.isAuthorizationAllowed(contextKey)
    )
  }

  async function verifyLifecycle(input: {
    operationId: number
    contextKey: string
    action: MemberLifecycleAction
    originalSnapshot: MemberSnapshot
  }): Promise<void> {
    const request = dependencies.requests.beginRequest({
      operationId: input.operationId,
      contextKey: input.contextKey,
      purpose: 'lifecycle-verification',
      isOperationCurrent: () =>
        dependencies.isOperationCurrent(input.operationId, input.contextKey),
      isAuthorizationAllowed: () =>
        dependencies.isAuthorizationAllowed(input.contextKey),
    })
    if (!request) return

    dependencies.dispatch({
      type: 'VERIFICATION_STARTED',
      operationId: input.operationId,
      contextKey: input.contextKey,
      requestId: request.requestId,
    })

    try {
      const latest = await memberDetail(
        input.originalSnapshot.member.id,
        request.signal
      )
      if (!canApply(request, input.operationId, input.contextKey)) return
      const result = lifecycleVerification(
        input.action,
        latest,
        dependencies.getIdentity()
      )
      dependencies.dispatch({
        type: 'VERIFICATION_SUCCEEDED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        requestId: request.requestId,
        result: {
          kind: 'lifecycle',
          latestSnapshot: result.latestSnapshot,
          desiredStatePresent: result.desiredStatePresent,
          eligible: result.eligible,
          classification: result.classification,
          message: result.message,
        },
      })
    } catch (error) {
      if (
        request.signal.aborted ||
        !canApply(request, input.operationId, input.contextKey)
      ) {
        return
      }
      dependencies.dispatch({
        type: 'VERIFICATION_FAILED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        requestId: request.requestId,
        error: normalizeCoreApiError(error).message,
      })
    } finally {
      dependencies.requests.completeRequest(request)
    }
  }

  return { verifyLifecycle }
}
