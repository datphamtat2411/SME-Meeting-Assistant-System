import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function importAuthStore() {
  const { useAuthStore } = await import('./auth-store')
  return useAuthStore
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
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
