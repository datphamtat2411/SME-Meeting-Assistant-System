import { normalizeCoreApiError } from '@/lib/core-api'
import { i18n } from '@/lib/i18n'
import {
  featureValidationMessage,
  requestErrorFormMessage,
} from '@/lib/i18n/presentation'
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

function setupReissueMessage(
  snapshot: MemberSnapshot,
  translate: (key: string) => string
): string {
  if (snapshot.member.accountStatus === 'PENDING_SETUP') {
    return translate('members:recovery_setupPending')
  }
  if (snapshot.member.accountStatus === 'ACTIVE') {
    return translate('members:recovery_setupActive')
  }
  return translate('members:recovery_setupInactive')
}

function lifecycleVerification(
  action: MemberLifecycleAction,
  snapshot: MemberSnapshot,
  identity: AuthContext | undefined,
  translate: (key: string) => string = (key) => i18n.t(key)
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
      message: setupReissueMessage(snapshot, translate),
    }
  }

  if (desired) {
    return {
      latestSnapshot: snapshot,
      desiredStatePresent: true,
      eligible: false,
      classification: 'desired-state-present',
      message: translate(`members:recovery_desired_${action}`),
    }
  }

  if (eligible) {
    return {
      latestSnapshot: snapshot,
      desiredStatePresent: false,
      eligible: true,
      classification: 'eligible-renewed-review',
      message: translate(`members:recovery_eligible_${action}`),
    }
  }

  return {
    latestSnapshot: snapshot,
    desiredStatePresent: false,
    eligible: false,
    classification: 'ineligible',
    message: translate(`members:recovery_ineligible_${status}`),
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
  function isCurrentRequestContext(
    request: MemberOperationRequest,
    operationId: number,
    contextKey: string
  ): boolean {
    return (
      dependencies.requests.isCurrentRequest(request, {
        operationId,
        contextKey,
      }) && dependencies.isOperationCurrent(operationId, contextKey)
    )
  }

  const verificationDeferredMessage = featureValidationMessage(
    'members:recovery_verificationDeferred'
  )

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
      if (
        !isCurrentRequestContext(request, input.operationId, input.contextKey)
      )
        return
      if (!dependencies.isAuthorizationAllowed(input.contextKey)) {
        dependencies.dispatch({
          type: 'VERIFICATION_DEFERRED',
          operationId: input.operationId,
          contextKey: input.contextKey,
          requestId: request.requestId,
          message: verificationDeferredMessage,
        })
        return
      }
      const result = lifecycleVerification(
        input.action,
        latest,
        dependencies.getIdentity(),
        featureValidationMessage
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
        !isCurrentRequestContext(request, input.operationId, input.contextKey)
      ) {
        return
      }
      if (!dependencies.isAuthorizationAllowed(input.contextKey)) {
        dependencies.dispatch({
          type: 'VERIFICATION_DEFERRED',
          operationId: input.operationId,
          contextKey: input.contextKey,
          requestId: request.requestId,
          message: verificationDeferredMessage,
        })
        return
      }
      dependencies.dispatch({
        type: 'VERIFICATION_FAILED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        requestId: request.requestId,
        error: requestErrorFormMessage(normalizeCoreApiError(error)),
      })
    } finally {
      dependencies.requests.completeRequest(request)
    }
  }

  return { verifyLifecycle }
}
