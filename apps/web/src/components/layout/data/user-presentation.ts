import { createContext, createElement, useContext } from 'react'
import { type AuthContext } from '@/features/auth/session/current-user'
import { type UserPresentation } from '../types'

const userPresentationContext = createContext<UserPresentation | null>(null)

export function UserPresentationProvider({
  user,
  children,
}: {
  user?: UserPresentation
  children: React.ReactNode
}) {
  return createElement(
    userPresentationContext.Provider,
    { value: user ?? null },
    children
  )
}

export function useUserPresentation(): UserPresentation | null {
  return useContext(userPresentationContext)
}

export function toUserPresentation(identity: AuthContext): UserPresentation {
  return {
    displayName: identity.displayName,
    email: identity.email,
    initials: getInitials(identity.displayName),
  }
}

function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)

  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()

  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}
