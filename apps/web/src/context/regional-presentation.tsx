import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { preferencesQuery } from '@/features/settings/preferences-api'
import { resolveRegionalPreferences } from '@/features/settings/regional-preferences'

type RegionalStatus = 'loading' | 'confirmed' | 'unavailable'

type RegionalPresentation = ReturnType<typeof resolveRegionalPreferences> & {
  status: RegionalStatus
  refreshFailed: boolean
  retry: () => void
}

const RegionalContext = createContext<RegionalPresentation | undefined>(
  undefined
)

export function RegionalPresentationProvider({
  children,
}: {
  children: ReactNode
}) {
  const query = useQuery(preferencesQuery())
  const resolved = resolveRegionalPreferences(
    query.data ?? { timezone: null, locale: null }
  )
  const status: RegionalStatus = query.data
    ? 'confirmed'
    : query.isError
      ? 'unavailable'
      : 'loading'

  return (
    <RegionalContext.Provider
      value={{
        ...resolved,
        status,
        refreshFailed: query.isError,
        retry: () => void query.refetch(),
      }}
    >
      {children}
    </RegionalContext.Provider>
  )
}

// Standalone presentation consumers can render provisionally without a
// workspace. An absent provider never represents confirmed preferences.
// eslint-disable-next-line react-refresh/only-export-components
export function useRegionalPresentation(): RegionalPresentation {
  const context = useContext(RegionalContext)
  return (
    context ?? {
      ...resolveRegionalPreferences({ timezone: null, locale: null }),
      status: 'loading',
      refreshFailed: false,
      retry: () => {},
    }
  )
}
