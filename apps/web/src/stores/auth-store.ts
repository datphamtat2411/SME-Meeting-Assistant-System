import { create } from 'zustand'

interface AuthState {
  auth: {
    reset: () => void
  }
}

export const useAuthStore = create<AuthState>()(() => ({
  auth: {
    reset: () => undefined,
  },
}))
