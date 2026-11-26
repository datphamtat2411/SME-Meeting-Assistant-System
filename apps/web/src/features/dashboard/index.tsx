import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { RequestError, RequestLoading } from '@/components/request-state'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import { getSessionContextKey } from '@/features/auth/session/session-revalidation'
import { ManagementDashboard } from './management-dashboard'
import { PersonalDashboard } from './personal-dashboard'

export function Dashboard() {
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        {identity && verification.canReadProtectedData ? (
          <>
            <PersonalDashboard
              key={getSessionContextKey(identity)}
              identity={identity}
            />
            {identity.globalRole === 'DEPARTMENT_MANAGER' && (
              <ManagementDashboard
                key={getSessionContextKey(identity)}
                identity={identity}
              />
            )}
          </>
        ) : verification.query.isError ? (
          <RequestError
            error={verification.query.error}
            retry={() => void verification.query.refetch()}
          />
        ) : (
          <RequestLoading label='Verifying your workspace…' />
        )}
      </Main>
    </>
  )
}
