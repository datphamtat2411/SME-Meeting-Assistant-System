import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function importAuthStore() {
  const { useAuthStore } = await import('./auth-store')
  return useAuthStore
}

function storageContents(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)
    return key === null ? '' : `${key}=${storage.getItem(key) ?? ''}`
  }).join('\n')
}

describe('useAuthStore', () => {
  beforeEach(() => {
    clearCookies()
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('keeps auth state free of browser-readable credentials', async () => {
    const useAuthStore = await importAuthStore()
    const auth = useAuthStore.getState().auth

    expect(Object.keys(auth)).toEqual(['reset'])
    auth.reset()
    expect(document.cookie).not.toContain('access')
    expect(document.cookie).not.toContain('token')
    const browserStorage = `${storageContents(localStorage)}\n${storageContents(sessionStorage)}`
    expect(browserStorage).not.toMatch(/access|refresh|token|password|secret/i)
  })
})
