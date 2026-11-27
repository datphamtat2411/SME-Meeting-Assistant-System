export interface MemberOperationRequest {
  operationId: number
  requestId: number
  contextKey: string
  signal: AbortSignal
  purpose: string
}

export interface BeginMemberOperationRequestOptions {
  operationId: number
  contextKey: string
  purpose: string
  isOperationCurrent: () => boolean
  isAuthorizationAllowed: () => boolean
  replaceActive?: boolean
}

export interface MemberOperationRequestCoordinator {
  beginRequest(
    options: BeginMemberOperationRequestOptions
  ): MemberOperationRequest | undefined
  isCurrentRequest(
    request: MemberOperationRequest,
    context?: { operationId: number; contextKey: string }
  ): boolean
  completeRequest(request: MemberOperationRequest): void
  cancelActiveRequest(operationId?: number): void
  cancelAllRequests(): void
  getActiveRequest(): MemberOperationRequest | undefined
}

/**
 * Coordinates every authoritative read used by a Member operation. The
 * controller still owns authorization and operation state; this object only
 * owns request identity and cancellation.
 */
export function createMemberOperationRequestCoordinator(): MemberOperationRequestCoordinator {
  let sequence = 0
  let active:
    | (MemberOperationRequest & { controller: AbortController })
    | undefined

  function beginRequest(
    options: BeginMemberOperationRequestOptions
  ): MemberOperationRequest | undefined {
    if (!options.isOperationCurrent() || !options.isAuthorizationAllowed()) {
      return undefined
    }

    if (active && !active.signal.aborted) {
      const sameRequest =
        active.operationId === options.operationId &&
        active.contextKey === options.contextKey &&
        active.purpose === options.purpose
      if (sameRequest && !options.replaceActive) return undefined
      active.controller.abort()
    }

    const controller = new AbortController()
    const request: MemberOperationRequest & {
      controller: AbortController
    } = {
      operationId: options.operationId,
      requestId: ++sequence,
      contextKey: options.contextKey,
      signal: controller.signal,
      purpose: options.purpose,
      controller,
    }
    active = request
    return request
  }

  function isCurrentRequest(
    request: MemberOperationRequest,
    context?: { operationId: number; contextKey: string }
  ): boolean {
    return (
      active === request &&
      !request.signal.aborted &&
      (context === undefined ||
        (request.operationId === context.operationId &&
          request.contextKey === context.contextKey))
    )
  }

  function completeRequest(request: MemberOperationRequest): void {
    if (active === request) active = undefined
  }

  function cancelActiveRequest(operationId?: number): void {
    if (!active) return
    if (operationId !== undefined && active.operationId !== operationId) return
    active.controller.abort()
    active = undefined
  }

  function cancelAllRequests(): void {
    active?.controller.abort()
    active = undefined
  }

  return {
    beginRequest,
    isCurrentRequest,
    completeRequest,
    cancelActiveRequest,
    cancelAllRequests,
    getActiveRequest: () => active,
  }
}
