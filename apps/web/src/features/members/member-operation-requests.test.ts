import { describe, expect, it } from 'vitest'
import { createMemberOperationRequestCoordinator } from './member-operation-requests'

function begin(
  coordinator: ReturnType<typeof createMemberOperationRequestCoordinator>,
  operationId = 1,
  purpose = 'member-detail',
  replaceActive = false,
  authorized = true
) {
  return coordinator.beginRequest({
    operationId,
    contextKey: 'actor:session',
    purpose,
    replaceActive,
    isOperationCurrent: () => true,
    isAuthorizationAllowed: () => authorized,
  })
}

describe('Member operation request coordination', () => {
  it('prevents duplicate reads and keeps a newer read current', () => {
    const coordinator = createMemberOperationRequestCoordinator()
    const first = begin(coordinator)
    expect(first).toBeDefined()
    expect(begin(coordinator)).toBeUndefined()

    const second = begin(coordinator, 1, 'member-detail', true)
    expect(second).toBeDefined()
    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0)
    expect(first?.signal.aborted).toBe(true)
    expect(coordinator.isCurrentRequest(first!)).toBe(false)
    expect(coordinator.isCurrentRequest(second!)).toBe(true)

    // A stale finally block cannot clear the newer active request.
    coordinator.completeRequest(first!)
    expect(coordinator.isCurrentRequest(second!)).toBe(true)
  })

  it('rejects obsolete success and failure guards after operation closure', () => {
    const coordinator = createMemberOperationRequestCoordinator()
    const request = begin(coordinator)
    expect(request).toBeDefined()
    coordinator.cancelAllRequests()

    expect(request?.signal.aborted).toBe(true)
    expect(coordinator.isCurrentRequest(request!)).toBe(false)
    expect(coordinator.getActiveRequest()).toBeUndefined()
  })

  it('does not allocate a request without the current authorization context', () => {
    const coordinator = createMemberOperationRequestCoordinator()
    expect(begin(coordinator, 1, 'member-detail', false, false)).toBeUndefined()
    expect(coordinator.getActiveRequest()).toBeUndefined()
  })

  it('invalidates a request when its operation or context no longer matches', () => {
    const coordinator = createMemberOperationRequestCoordinator()
    const request = begin(coordinator)
    expect(request).toBeDefined()
    expect(
      coordinator.isCurrentRequest(request!, {
        operationId: 2,
        contextKey: 'actor:session',
      })
    ).toBe(false)
    expect(
      coordinator.isCurrentRequest(request!, {
        operationId: 1,
        contextKey: 'actor:new-session',
      })
    ).toBe(false)
  })
})
