import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ListChecks, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { RequestError, RequestLoading } from '@/components/request-state'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import { getSessionContextKey } from '@/features/auth/session/session-revalidation'
import { managementDashboardQuery } from './dashboard-api'
import { Metric } from './dashboard-metric'
import { PersonalDashboard } from './personal-dashboard'

export function Dashboard() {
  const verification = useCurrentUserVerification()
  const identity = verification.identity
  const isManager =
    verification.canReadProtectedData &&
    (identity?.globalRole === 'ADMINISTRATOR' ||
      identity?.globalRole === 'DEPARTMENT_MANAGER')
  const management = useQuery({
    ...managementDashboardQuery(),
    enabled: Boolean(isManager),
  })
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        {identity && verification.canReadProtectedData ? (
          <PersonalDashboard
            key={getSessionContextKey(identity)}
            identity={identity}
          />
        ) : verification.query.isError ? (
          <RequestError
            error={verification.query.error}
            retry={() => void verification.query.refetch()}
          />
        ) : (
          <RequestLoading label='Verifying your workspace…' />
        )}
        {isManager && (
          <Card>
            <CardHeader>
              <CardTitle>Managed action items</CardTitle>
            </CardHeader>
            <CardContent>
              {management.isPending ? (
                <RequestLoading />
              ) : management.isError ? (
                <RequestError
                  error={management.error}
                  retry={() => void management.refetch()}
                />
              ) : (
                management.data && (
                  <>
                    <div className='grid gap-4 sm:grid-cols-3'>
                      <Metric
                        label='Official actions'
                        value={management.data.actionItems.totalOfficial}
                        icon={ListChecks}
                      />
                      <Metric
                        label='Completed'
                        value={management.data.actionItems.done}
                        icon={CheckCircle2}
                      />
                      <Metric
                        label='Overdue'
                        value={management.data.actionItems.overdue}
                        icon={TriangleAlert}
                      />
                    </div>
                    <p className='mt-3 text-xs text-muted-foreground'>
                      Metrics are restricted to authorized organizational units.
                      Unapproved KPIs are intentionally not displayed.
                    </p>
                  </>
                )
              )}
            </CardContent>
          </Card>
        )}
      </Main>
    </>
  )
}
