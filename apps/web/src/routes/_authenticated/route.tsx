import { createFileRoute } from '@tanstack/react-router'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import {
  AuthenticatedRouteFallback,
} from '@/components/layout/authenticated-route-fallback'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'

export const Route = createFileRoute('/_authenticated')({
  component: AuthenticatedLayout,
  errorComponent: AuthenticatedError,
  notFoundComponent: AuthenticatedNotFound,
})

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedError({ reset }: { reset: () => void }) {
  return (
    <AuthenticatedRouteFallback>
      <GeneralError reset={reset} className='min-h-full' />
    </AuthenticatedRouteFallback>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
function AuthenticatedNotFound() {
  return (
    <AuthenticatedRouteFallback>
      <NotFoundError className='min-h-full' />
    </AuthenticatedRouteFallback>
  )
}
