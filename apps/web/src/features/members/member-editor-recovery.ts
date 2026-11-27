import { normalizeCoreApiError } from '@/lib/core-api'
import type { AuthorizedMemberDirectoryAccess } from './member-access-policy'
import {
  memberDetail,
  reconcileMemberCreation,
  type MemberCreatePayload,
  type MemberPatchPayload,
  type MemberSnapshot,
} from './member-api'
import type {
  MemberOperationRequest,
  MemberOperationRequestCoordinator,
} from './member-operation-requests'
import { type MemberOperationAction } from './member-operation-state'
import {
  memberPatchMatchesMember,
  reconcileMemberEdit,
} from './member-reconciliation'

interface MemberEditorRecoveryDependencies {
  requests: MemberOperationRequestCoordinator
  dispatch: (action: MemberOperationAction) => void
  getAccess: () => AuthorizedMemberDirectoryAccess | undefined
  isAuthorizationAllowed: (contextKey: string) => boolean
  isOperationCurrent: (operationId: number, contextKey: string) => boolean
}

function creationVerificationMessage(
  result: Awaited<ReturnType<typeof reconcileMemberCreation>>
): string {
  if (result.status === 'found') {
    return result.metadataMatches
      ? 'A visible account has the submitted normalized email and matching metadata. The request may have succeeded, but no second request was sent.'
      : 'A visible account has the submitted normalized email but different metadata. Review that account before deciding what to do.'
  }
  return result.visibilityLimited
    ? 'No matching account is visible in your current management scope. This does not establish that the email is globally unused or that the original request failed.'
    : 'No matching account was found in the authoritative directory. The original request was not confirmed; review the preserved draft before explicitly deciding whether to retry.'
}

function editReconciliationMessage(
  reconciliation: ReturnType<typeof reconcileMemberEdit>
): string {
  if (reconciliation.conflicts.length > 0) {
    return 'The latest member state contains field conflicts. Compare the server values with your intended changes and resolve each conflict before continuing.'
  }
  const fields = Object.values(reconciliation.fields)
  const hasIntent = fields.some((field) => field.userChanged)
  const hasServerChanges = fields.some((field) => field.serverChanged)
  const intendedValuesArePresent = fields.every(
    (field) =>
      !field.userChanged ||
      (field.intended !== undefined &&
        (Array.isArray(field.latest) && Array.isArray(field.intended)
          ? field.latest.length === field.intended.length &&
            field.latest.every((id) => field.intended?.includes(id))
          : field.latest === field.intended))
  )
  if (hasIntent && intendedValuesArePresent) {
    return hasServerChanges
      ? 'The latest member state already contains your intended values and also includes independent server changes. No second request was sent; review the current state before continuing.'
      : 'The latest member state already contains your intended values. The request may have succeeded, but the result cannot be attributed and no second request was sent.'
  }
  return hasServerChanges
    ? 'The latest member state includes independent server changes. Your intended changes are preserved for review against this version.'
    : 'Review the latest authoritative member state before deciding what to do.'
}

interface MemberEditorRecovery {
  verifyCreation(input: {
    operationId: number
    contextKey: string
    payload: MemberCreatePayload
  }): Promise<void>
  verifyEdit(input: {
    operationId: number
    contextKey: string
    original: MemberSnapshot
    payload: MemberPatchPayload
  }): Promise<void>
}

export function createMemberEditorRecovery(
  dependencies: MemberEditorRecoveryDependencies
): MemberEditorRecovery {
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

  const verificationDeferredMessage =
    'Current administration access could not be verified while checking the request outcome. The protected response was discarded; verify access and reload the authoritative state before continuing.'

  async function verifyCreation(input: {
    operationId: number
    contextKey: string
    payload: MemberCreatePayload
  }): Promise<void> {
    const access = dependencies.getAccess()
    const request = dependencies.requests.beginRequest({
      operationId: input.operationId,
      contextKey: input.contextKey,
      purpose: 'editor-creation-verification',
      isOperationCurrent: () =>
        dependencies.isOperationCurrent(input.operationId, input.contextKey),
      isAuthorizationAllowed: () =>
        dependencies.isAuthorizationAllowed(input.contextKey) &&
        dependencies.getAccess()?.type === 'authorized',
    })
    if (!request || access === undefined) return
    if (access.type !== 'authorized') {
      dependencies.requests.completeRequest(request)
      return
    }

    dependencies.dispatch({
      type: 'VERIFICATION_STARTED',
      operationId: input.operationId,
      contextKey: input.contextKey,
      requestId: request.requestId,
    })

    try {
      const result = await reconcileMemberCreation(
        input.payload,
        access,
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
      dependencies.dispatch({
        type: 'VERIFICATION_SUCCEEDED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        requestId: request.requestId,
        result: {
          kind: 'create',
          reconciliation: result,
          message: creationVerificationMessage(result),
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
        error: normalizeCoreApiError(error).message,
      })
    } finally {
      dependencies.requests.completeRequest(request)
    }
  }

  async function verifyEdit(input: {
    operationId: number
    contextKey: string
    original: MemberSnapshot
    payload: MemberPatchPayload
  }): Promise<void> {
    const request = dependencies.requests.beginRequest({
      operationId: input.operationId,
      contextKey: input.contextKey,
      purpose: 'editor-edit-verification',
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
        input.original.member.id,
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
      const reconciliation = reconcileMemberEdit(
        input.original,
        input.payload,
        latest
      )
      dependencies.dispatch({
        type: 'VERIFICATION_SUCCEEDED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        requestId: request.requestId,
        result: {
          kind: 'edit',
          latestSnapshot: latest,
          reconciliation,
          latestMatchesRequest: memberPatchMatchesMember(
            latest.member,
            input.payload
          ),
          message: editReconciliationMessage(reconciliation),
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
        error: normalizeCoreApiError(error).message,
      })
    } finally {
      dependencies.requests.completeRequest(request)
    }
  }

  return { verifyCreation, verifyEdit }
}
