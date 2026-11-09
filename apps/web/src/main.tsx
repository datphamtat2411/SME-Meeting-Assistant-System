import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  clearCurrentUserCache,
  getSafeSessionRedirect,
} from '@/features/auth/session/current-user'
import { configureAuthLifecycle } from '@/features/auth/session/auth-lifecycle'
import { handleServerError } from '@/lib/handle-server-error'
import { setRequestRecoverySessionLossHandler } from '@/lib/request-recovery'
import { DirectionProvider } from './context/direction-provider'
import { FontProvider } from './context/font-provider'
import { ThemeProvider } from './context/theme-provider'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Styles
import './styles/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // eslint-disable-next-line no-console
        if (import.meta.env.DEV) console.log({ failureCount, error })

        const apiError = normalizeCoreApiError(error)
        if (apiError.recoveryOutcome) return false
        if ([401, 403, 429].includes(apiError.status ?? 0)) return false
        if (!apiError.isNetworkError && !apiError.isServerError) return false

        return failureCount < 3
      },
      refetchOnWindowFocus: import.meta.env.PROD,
      staleTime: 10 * 1000, // 10s
    },
    mutations: {
      onError: (error) => {
        const apiError = normalizeCoreApiError(error)
        if (apiError.recoveryOutcome || [401, 403, 429].includes(apiError.status ?? 0)) {
          return
        }

        handleServerError(error)

        if (apiError.status === 304) {
          toast.error('Content not modified!')
        }
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      const apiError = normalizeCoreApiError(error)
      if (apiError.recoveryOutcome) return

      if (apiError.status === 500) {
        toast.error('Internal Server Error!')
        // Only navigate to error page in production to avoid disrupting HMR in development
        if (import.meta.env.PROD) {
          router.navigate({ to: '/500' })
        }
      }
    },
  }),
})

// Create a new router instance
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

function containProtectedState(): void {
  void queryClient.cancelQueries()
  queryClient.removeQueries()
  queryClient.getMutationCache().clear()
  clearCurrentUserCache(queryClient)
}

configureAuthLifecycle({
  onContainment: () => {
    containProtectedState()
    void router.invalidate()
  },
  onNavigate: (redirect) => {
    void router.navigate({
      to: '/sign-in',
      search: { redirect: getSafeSessionRedirect(redirect) },
      replace: true,
    })
  },
})

setRequestRecoverySessionLossHandler(() => {
  containProtectedState()
  void router.invalidate()
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FontProvider>
            <DirectionProvider>
              <RouterProvider router={router} />
            </DirectionProvider>
          </FontProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
