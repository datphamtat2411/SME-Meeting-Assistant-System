import { createContext, useContext, type ReactNode } from 'react'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MeetingView, ParticipantView } from './data/detail-api'
import type {
  MeetingWorkspaceCapabilities,
  MeetingWorkspaceMembership,
} from './meeting-workspace-capabilities'

export interface MeetingWorkspaceContextValue {
  meetingId: string
  identity: AuthContext
  meeting: MeetingView
  etag: string
  membership: MeetingWorkspaceMembership
  participants: ParticipantView[]
  capabilities: MeetingWorkspaceCapabilities
}

const MeetingWorkspaceContext =
  createContext<MeetingWorkspaceContextValue | null>(null)

export function MeetingWorkspaceProvider({
  value,
  children,
}: {
  value: MeetingWorkspaceContextValue
  children: ReactNode
}) {
  return (
    <MeetingWorkspaceContext.Provider value={value}>
      {children}
    </MeetingWorkspaceContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMeetingWorkspace(): MeetingWorkspaceContextValue {
  const context = useContext(MeetingWorkspaceContext)
  if (!context) {
    throw new Error(
      'Meeting workspace features must be composed inside MeetingWorkspaceProvider.'
    )
  }
  return context
}
