import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  ListChecks,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { currentUserQueryOptions } from '@/features/auth/session/current-user'
import {
  managementDashboardQuery,
  personalDashboardQuery,
} from './dashboard-api'

const dateTime = (date: string | null) =>
  date ? new Date(date).toLocaleString() : 'Not scheduled'
function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: typeof CalendarDays
}) {
  return (
    <Card>
      <CardContent className='flex items-center justify-between gap-3 p-5'>
        <div>
          <p className='text-sm text-muted-foreground'>{label}</p>
          <p className='mt-1 text-3xl font-bold'>{value}</p>
        </div>
        <Icon className='size-7 text-primary' />
      </CardContent>
    </Card>
  )
}
export function Dashboard() {
  const identity = useQuery(currentUserQueryOptions())
  const personal = useQuery(personalDashboardQuery())
  const isManager =
    identity.data?.globalRole === 'ADMINISTRATOR' ||
    identity.data?.globalRole === 'DEPARTMENT_MANAGER'
  const management = useQuery({
    ...managementDashboardQuery(),
    enabled: Boolean(isManager),
  })
  const data = personal.data
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div className='flex flex-wrap items-end justify-between gap-3'>
          <div>
            <p className='text-sm text-primary'>Workspace overview</p>
            <h1 className='text-3xl font-bold'>Dashboard</h1>
            <p className='text-muted-foreground'>
              Live meeting activity and official assigned work.
            </p>
          </div>
          <Button asChild>
            <Link to='/meetings'>Browse meetings</Link>
          </Button>
        </div>
        {personal.isPending ? (
          <RequestLoading />
        ) : personal.isError ? (
          <RequestError
            error={personal.error}
            retry={() => void personal.refetch()}
          />
        ) : (
          data && (
            <>
              <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
                <Metric
                  label='Scheduled meetings'
                  value={data.meetingCountsByState.SCHEDULED ?? 0}
                  icon={CalendarDays}
                />
                <Metric
                  label='Open actions'
                  value={data.assignedActionItems.open}
                  icon={ListChecks}
                />
                <Metric
                  label='In progress'
                  value={data.assignedActionItems.inProgress}
                  icon={Timer}
                />
                <Metric
                  label='Overdue'
                  value={data.assignedActionItems.overdue}
                  icon={TriangleAlert}
                />
              </div>
              <div className='grid gap-4 xl:grid-cols-2'>
                <Card>
                  <CardHeader>
                    <CardTitle className='flex items-center gap-2'>
                      <Clock3 className='size-5' />
                      Upcoming meetings
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='space-y-2'>
                    {data.upcomingMeetings.length ? (
                      data.upcomingMeetings.map((meeting) => (
                        <Link
                          className='block rounded-lg border p-3 hover:bg-accent'
                          key={meeting.id}
                          to='/meetings/$meetingId'
                          params={{ meetingId: meeting.id }}
                        >
                          <div className='flex items-center justify-between gap-2'>
                            <strong>{meeting.title}</strong>
                            <Badge variant='outline'>{meeting.status}</Badge>
                          </div>
                          <p className='mt-1 text-xs text-muted-foreground'>
                            {dateTime(meeting.scheduledStartAt)}
                          </p>
                        </Link>
                      ))
                    ) : (
                      <RequestEmpty title='No upcoming meetings' />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className='flex items-center gap-2'>
                      <CheckCircle2 className='size-5' />
                      Recently ended
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='space-y-2'>
                    {data.recentMeetings.length ? (
                      data.recentMeetings.map((meeting) => (
                        <Link
                          className='block rounded-lg border p-3 hover:bg-accent'
                          key={meeting.id}
                          to='/meetings/$meetingId'
                          params={{ meetingId: meeting.id }}
                        >
                          <strong>{meeting.title}</strong>
                          <p className='mt-1 text-xs text-muted-foreground'>
                            {dateTime(meeting.endedAt)}
                          </p>
                        </Link>
                      ))
                    ) : (
                      <RequestEmpty title='No recent meetings' />
                    )}
                  </CardContent>
                </Card>
              </div>
              <p className='text-xs text-muted-foreground'>
                Personal dashboard as of {dateTime(data.asOf)} ·{' '}
                {data.assignedActionItems.done} completed actions.
              </p>
            </>
          )
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
