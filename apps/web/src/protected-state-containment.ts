import type { QueryClient } from '@tanstack/react-query'
import { clearCurrentUserCache } from '@/features/auth/session/current-user'
import { clearPersistedExportOperations } from '@/features/meetings/media/use-export-operation-owner'

/** Retire all protected state before a changed session can render. */
export function containProtectedState(queryClient: QueryClient): void {
  void queryClient.cancelQueries()
  queryClient.removeQueries()
  queryClient.getMutationCache().clear()
  clearCurrentUserCache(queryClient)
  clearPersistedExportOperations()
}
