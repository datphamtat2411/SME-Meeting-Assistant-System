import type { ParticipantView } from './data/detail-api'

export type WorkspaceLookupState<T> = {
  hasId: boolean
  data?: T
  isPending: boolean
  isError: boolean
  onRetry: () => void
}

export type WorkspaceParticipantState = {
  data?: ParticipantView[]
  isPending: boolean
  isError: boolean
  onRetry: () => void
}
