import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_LIFECYCLE_CHANNEL_NAME,
  AUTH_LIFECYCLE_STORAGE_KEY,
  createAuthLifecycleCoordinator,
  type AuthLifecycleBroadcast,
  type AuthLifecycleLockBarrier,
} from './auth-lifecycle'

class TestBroadcast implements AuthLifecycleBroadcast {
  private listeners = new Set<(event: { data: unknown }) => void>()

  constructor(public readonly peers: TestBroadcast[] = []) {}

  addEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void
  ): void {
    this.listeners.add(listener)
  }

  removeEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void
  ): void {
    this.listeners.delete(listener)
  }

  postMessage(message: unknown): void {
    for (const peer of this.peers) {
      for (const listener of peer.listeners) listener({ data: message })
    }
  }

  close(): void {
    this.listeners.clear()
  }
}

function immediateBarrier(generation = 1): AuthLifecycleLockBarrier {
  return {
    generation,
    waitForRecovery: async () => undefined,
  }
}

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    }),
    removeItem: vi.fn(() => {
      value = null
    }),
    value: () => value,
  }
}

describe('auth lifecycle coordinator', () => {
  it('contains protected state immediately, serializes confirmation, and clears the marker only after success', async () => {
    const logout = vi.fn(async () => undefined)
    const contain = vi.fn()
    const navigate = vi.fn()
    const storage = memoryStorage()
    const coordinator = createAuthLifecycleCoordinator(
      {
        logout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-a',
        broadcast: null,
        storage,
        storageEventTarget: null,
        onContainment: contain,
        onNavigate: navigate,
      }
    )

    const first = coordinator.startLogout({ redirect: '/tasks' })
    const second = coordinator.startLogout({ redirect: '/tasks' })

    expect(coordinator.getState()).toBe('pending')
    expect(contain).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/tasks')
    await Promise.resolve()
    expect(logout).toHaveBeenCalledOnce()
    await expect(first).resolves.toMatchObject({ state: 'confirmed' })
    await expect(second).resolves.toMatchObject({ state: 'confirmed' })
    expect(coordinator.getState()).toBe('confirmed')
    expect(storage.removeItem).toHaveBeenCalledWith(AUTH_LIFECYCLE_STORAGE_KEY)
    coordinator.dispose()
  })

  it('keeps an unconfirmed operation retryable without claiming revocation', async () => {
    const logout = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined)
    const storage = memoryStorage()
    const coordinator = createAuthLifecycleCoordinator(
      {
        logout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      { sourceId: 'tab-a', broadcast: null, storage, storageEventTarget: null }
    )

    await expect(coordinator.startLogout()).resolves.toMatchObject({
      state: 'uncertain',
    })
    expect(coordinator.getState()).toBe('uncertain')
    expect(storage.value()).toContain('logout-uncertain')

    await expect(coordinator.retryLogout()).resolves.toMatchObject({
      state: 'confirmed',
    })
    expect(logout).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })

  it('propagates intent and terminal status across tabs without duplicate logout calls', async () => {
    const firstChannel = new TestBroadcast()
    const secondChannel = new TestBroadcast([firstChannel])
    firstChannel['peers'].push(secondChannel)
    const firstLogout = vi.fn(async () => undefined)
    const secondLogout = vi.fn(async () => undefined)
    const secondContain = vi.fn()
    const second = createAuthLifecycleCoordinator(
      {
        logout: secondLogout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-b',
        broadcast: secondChannel,
        storage: null,
        storageEventTarget: null,
        onContainment: secondContain,
      }
    )
    const first = createAuthLifecycleCoordinator(
      {
        logout: firstLogout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-a',
        broadcast: firstChannel,
        storage: null,
        storageEventTarget: null,
      }
    )

    await expect(first.startLogout()).resolves.toMatchObject({
      state: 'confirmed',
    })
    expect(secondContain).toHaveBeenCalledOnce()
    expect(firstLogout).toHaveBeenCalledOnce()
    expect(secondLogout).not.toHaveBeenCalled()
    expect(second.getState()).toBe('confirmed')
    expect(AUTH_LIFECYCLE_CHANNEL_NAME).not.toBe('sme-session-recovery')
    first.dispose()
    second.dispose()
  })

  it('ignores stale terminal messages and initializes from an uncertain marker', () => {
    const marker = JSON.stringify({
      sourceId: 'old-tab',
      operationId: 'operation-9',
      generation: 9,
      status: 'logout-uncertain',
    })
    const storage = memoryStorage(marker)
    const coordinator = createAuthLifecycleCoordinator(
      {
        logout: vi.fn(async () => undefined),
        beginRecoveryBarrier: () => immediateBarrier(9),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-new',
        broadcast: null,
        storage,
        storageEventTarget: null,
      }
    )

    expect(coordinator.getState()).toBe('uncertain')
    expect(coordinator.getSnapshot().generation).toBe(9)
    coordinator.receiveMessage({
      sourceId: 'old-tab',
      operationId: 'operation-8',
      generation: 8,
      status: 'logout-confirmed',
    })
    expect(coordinator.getState()).toBe('uncertain')
    coordinator.dispose()
  })

  it('replays initial containment after lifecycle callbacks are configured', () => {
    const storage = memoryStorage(
      JSON.stringify({
        sourceId: 'old-tab',
        operationId: 'operation-10',
        generation: 10,
        status: 'logout-started',
      })
    )
    const contain = vi.fn()
    const navigate = vi.fn()
    const coordinator = createAuthLifecycleCoordinator(
      {
        logout: vi.fn(async () => undefined),
        beginRecoveryBarrier: () => immediateBarrier(10),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'new-tab',
        broadcast: null,
        storage,
        storageEventTarget: null,
      }
    )

    coordinator.configure({ onContainment: contain, onNavigate: navigate })

    expect(contain).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(undefined)
    coordinator.dispose()
  })

  it('does not retry logout while another tab still owns a pending operation', async () => {
    const firstChannel = new TestBroadcast()
    const secondChannel = new TestBroadcast([firstChannel])
    firstChannel['peers'].push(secondChannel)
    let resolveLogout: () => void = () => undefined
    const firstLogout = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve
        })
    )
    const secondLogout = vi.fn(async () => undefined)
    const first = createAuthLifecycleCoordinator(
      {
        logout: firstLogout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-a',
        broadcast: firstChannel,
        storage: null,
        storageEventTarget: null,
      }
    )
    const second = createAuthLifecycleCoordinator(
      {
        logout: secondLogout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async (callback) => callback(),
      },
      {
        sourceId: 'tab-b',
        broadcast: secondChannel,
        storage: null,
        storageEventTarget: null,
      }
    )

    const firstAttempt = first.startLogout()
    await vi.waitFor(() => expect(firstLogout).toHaveBeenCalledOnce())
    expect(second.getState()).toBe('pending')

    const retryAttempt = second.retryLogout()
    expect(secondLogout).not.toHaveBeenCalled()

    resolveLogout()
    await expect(firstAttempt).resolves.toMatchObject({ state: 'confirmed' })
    await expect(retryAttempt).resolves.toMatchObject({ state: 'confirmed' })
    expect(secondLogout).not.toHaveBeenCalled()
    second.dispose()
    first.dispose()
  })

  it('does not report success when shared lock coordination is unavailable', async () => {
    const logout = vi.fn(async () => undefined)
    const coordinator = createAuthLifecycleCoordinator(
      {
        logout,
        beginRecoveryBarrier: () => immediateBarrier(),
        withRecoveryLock: async () => {
          throw Object.assign(new Error('unavailable'), {
            code: 'RECOVERY_UNAVAILABLE',
          })
        },
      },
      {
        sourceId: 'tab-a',
        broadcast: null,
        storage: null,
        storageEventTarget: null,
      }
    )

    await expect(coordinator.startLogout()).resolves.toMatchObject({
      state: 'uncertain',
    })
    expect(logout).not.toHaveBeenCalled()
    coordinator.dispose()
  })
})
