import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ListChecks, TriangleAlert } from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { formatPresentationInstant } from '@/lib/presentation-time'
import { useRegionalPresentation } from '@/context/regional-presentation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { RequestError, RequestLoading } from '@/components/request-state'
import type { AuthContext } from '@/features/auth/session/current-user'
import {
  getSessionContextKey,
  reconcileProtectedScope,
  requestSessionRevalidation,
  resetProtectedScopeReconciliation,
} from '@/features/auth/session/session-revalidation'
import {
  getMemberDirectoryAccess,
  type AuthorizedMemberDirectoryAccess,
} from '@/features/members/member-access-policy'
import { organizationalUnitsQuery } from '@/features/members/organization-api'
import { managementDashboardQuery } from './dashboard-api'
import { Metric } from './dashboard-metric'
import { customPeriod, rollingPeriod } from './management-period'

const selectClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary'

const metricLabels: Record<string, string> = {
  MEETING_COUNTS: 'Meeting counts',
  PROCESSING_OUTCOMES: 'AI processing outcomes',
  COMPLETION_RATE: 'Completion rate',
}
const reasonLabels: Record<string, string> = {
  MEETING_ORGANIZATIONAL_REPORTING_SCOPE_NOT_APPROVED:
    'Organizational meeting attribution is not yet approved.',
  AI_PROCESSING_REPORTING_SCOPE_AND_TAXONOMY_NOT_APPROVED:
    'Processing reporting scope and categories are not yet approved.',
  PRODUCT_DENOMINATOR_AND_COHORT_POLICY_NOT_APPROVED:
    'The completion-rate denominator and cohort policy are not yet approved.',
}

export function ManagementDashboard({ identity }: { identity: AuthContext }) {
  if (identity.globalRole !== 'DEPARTMENT_MANAGER') return null
  const access = getMemberDirectoryAccess(identity)
  if (
    access.type !== 'authorized' ||
    identity.directoryManagementScope.allUnits
  ) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Management overview</CardTitle>
          <p className='text-sm text-muted-foreground'>
            No active organizational management scope is available.
          </p>
        </CardHeader>
      </Card>
    )
  }
  return <ManagementReport identity={identity} access={access} />
}

function ManagementReport({
  identity,
  access,
}: {
  identity: AuthContext
  access: AuthorizedMemberDirectoryAccess
}) {
  const { locale } = useRegionalPresentation()
  const numberFormat = new Intl.NumberFormat(locale)
  const queryClient = useQueryClient()
  const contextKey = getSessionContextKey(identity)
  const [preset, setPreset] = useState('30')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [unitId, setUnitId] = useState('')
  const [filterError, setFilterError] = useState('')
  const [appliedPreset, setAppliedPreset] = useState('30')
  const [applied, setApplied] = useState(() => rollingPeriod(30))
  const report = useQuery(
    managementDashboardQuery(contextKey, access.unitIds, applied)
  )
  const units = useQuery({
    ...organizationalUnitsQuery(access),
    meta: { featureErrorBoundary: true },
  })
  const availableUnits = (units.isError ? [] : (units.data ?? [])).filter(
    (unit) => access.unitIds.includes(unit.id)
  )
  const data = report.isError ? undefined : report.data
  const timezone = data?.timezone

  useEffect(() => {
    if (report.isError) {
      const failure = normalizeCoreApiError(report.error)
      if (
        failure.status === 401 ||
        failure.status === 403 ||
        failure.code === 'DASHBOARD_SCOPE_CHANGED'
      ) {
        void reconcileProtectedScope(queryClient, 'management', contextKey)
      }
    } else if (report.isSuccess && !report.isFetching) {
      resetProtectedScopeReconciliation(queryClient, 'management', contextKey)
    }
  }, [
    contextKey,
    queryClient,
    report.error,
    report.isError,
    report.isFetching,
    report.isSuccess,
  ])

  function applyFilters() {
    try {
      if (unitId && !availableUnits.some((unit) => unit.id === unitId)) {
        throw new Error('Select an available managed organizational unit.')
      }
      let period
      if (preset === 'custom') {
        if (!timezone) {
          throw new Error(
            'Verify the reporting timezone before using custom dates.'
          )
        }
        period = customPeriod(start, end, timezone)
      } else {
        period = rollingPeriod(preset === '7' ? 7 : preset === '90' ? 90 : 30)
      }
      const next = { ...period, orgUnitId: unitId || undefined }
      setFilterError('')
      setAppliedPreset(preset)
      if (
        applied.from === next.from &&
        applied.to === next.to &&
        applied.orgUnitId === next.orgUnitId
      ) {
        void report.refetch()
      } else {
        setApplied(next)
      }
    } catch (error) {
      setFilterError(
        error instanceof Error ? error.message : 'Invalid filters.'
      )
    }
  }

  function refreshReport() {
    if (appliedPreset === 'custom') {
      void report.refetch()
      return
    }
    const period = rollingPeriod(
      appliedPreset === '7' ? 7 : appliedPreset === '90' ? 90 : 30
    )
    if (period.to === applied.to) {
      void report.refetch()
      return
    }
    setApplied({ ...period, orgUnitId: applied.orgUnitId })
  }

  function retryReport() {
    const failure = normalizeCoreApiError(report.error)
    if (
      failure.status === 403 ||
      failure.status === 401 ||
      failure.code === 'DASHBOARD_SCOPE_CHANGED'
    ) {
      requestSessionRevalidation()
    } else {
      void report.refetch()
    }
  }

  const statuses = data
    ? [
        { label: 'Open', count: data.actionItems.open },
        { label: 'In progress', count: data.actionItems.inProgress },
        { label: 'Completed', count: data.actionItems.done },
        { label: 'Cancelled', count: data.actionItems.cancelled },
      ]
    : []
  const max = Math.max(1, ...statuses.map((status) => status.count))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Management overview</CardTitle>
        <p className='text-sm text-muted-foreground'>
          Current status of official action items created during the applied
          reporting period, within your managed units.
        </p>
      </CardHeader>
      <CardContent className='space-y-5'>
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault()
            applyFilters()
          }}
        >
          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='space-y-1 text-sm font-medium'>
              <span>Reporting period</span>
              <select
                className={selectClass}
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
              >
                <option value='7'>Last 7 days</option>
                <option value='30'>Last 30 days</option>
                <option value='90'>Last 90 days</option>
                <option value='custom' disabled={!timezone}>
                  Custom dates
                </option>
              </select>
            </label>
            <label className='space-y-1 text-sm font-medium'>
              <span>Organizational scope</span>
              <select
                className={selectClass}
                value={unitId}
                onChange={(event) => setUnitId(event.target.value)}
              >
                <option value=''>All managed units</option>
                {availableUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {units.isError && (
            <div className='text-sm text-muted-foreground'>
              Unit names are unavailable. Aggregate reporting remains available.
              <Button
                type='button'
                size='sm'
                variant='link'
                onClick={() => void units.refetch()}
              >
                Retry unit lookup
              </Button>
            </div>
          )}
          {preset === 'custom' && (
            <div className='grid gap-3 sm:grid-cols-2'>
              <label className='space-y-1 text-sm font-medium'>
                <span>Start date</span>
                <Input
                  type='date'
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  required
                />
              </label>
              <label className='space-y-1 text-sm font-medium'>
                <span>End date (inclusive)</span>
                <Input
                  type='date'
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                  required
                />
              </label>
              <p className='text-xs text-muted-foreground sm:col-span-2'>
                Calendar dates use {timezone ?? 'the reporting timezone'}.
              </p>
            </div>
          )}
          {filterError && (
            <p role='alert' className='text-sm text-destructive'>
              {filterError}
            </p>
          )}
          <div className='flex flex-wrap gap-2'>
            <Button type='submit'>Apply filters</Button>
            <Button
              type='button'
              variant='outline'
              disabled={report.isFetching}
              onClick={refreshReport}
            >
              Refresh applied report
            </Button>
          </div>
        </form>
        {report.isError ? (
          <RequestError error={report.error} retry={retryReport} />
        ) : report.isPending || !data ? (
          <RequestLoading label='Loading management report…' />
        ) : (
          <>
            <div className='space-y-1 text-xs text-muted-foreground'>
              <p>
                Applied period:{' '}
                {formatPresentationInstant(
                  data.period.fromInclusive,
                  data.timezone,
                  locale
                )}{' '}
                to{' '}
                {formatPresentationInstant(
                  data.period.toExclusive,
                  data.timezone,
                  locale
                )}{' '}
                (exclusive)
              </p>
              <p>
                Reporting timezone: {data.timezone} · As of{' '}
                {formatPresentationInstant(data.asOf, data.timezone, locale)}
              </p>
              <p>
                Scope:{' '}
                {applied.orgUnitId
                  ? (availableUnits.find(
                      (unit) => unit.id === applied.orgUnitId
                    )?.name ?? 'Selected managed unit')
                  : 'All managed units'}{' '}
                ({numberFormat.format(data.scope.organizationalUnitIds.length)})
              </p>
              {report.isFetching && <p role='status'>Refreshing report…</p>}
            </div>
            <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
              <Metric
                label='Official actions'
                value={data.actionItems.totalOfficial}
                icon={ListChecks}
              />
              <Metric
                label='Pending'
                value={data.actionItems.open + data.actionItems.inProgress}
                icon={ListChecks}
              />
              <Metric
                label='Completed'
                value={data.actionItems.done}
                icon={CheckCircle2}
              />
              <Metric
                label='Overdue'
                value={data.actionItems.overdue}
                icon={TriangleAlert}
              />
            </div>
            {data.actionItems.totalOfficial === 0 && (
              <p className='text-sm text-muted-foreground'>
                No official action items were created in the applied period and
                scope.
              </p>
            )}
            <section
              className='space-y-3'
              aria-label='Action item status distribution'
            >
              <h3 className='text-sm font-semibold'>
                Action item status distribution
              </h3>
              {statuses.map((status) => (
                <div
                  key={status.label}
                  className='grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm'
                >
                  <span>{status.label}</span>
                  <div
                    className='h-3 overflow-hidden rounded bg-muted'
                    aria-hidden='true'
                  >
                    <div
                      className='h-full rounded bg-primary'
                      style={{ width: (status.count / max) * 100 + '%' }}
                    />
                  </div>
                  <span className='tabular-nums'>
                    {numberFormat.format(status.count)}
                  </span>
                </div>
              ))}
              <p className='text-xs text-muted-foreground'>
                Overdue is a subset of pending work, not a separate lifecycle
                state.
              </p>
            </section>
            {data.unavailableMetrics.length > 0 && (
              <section className='space-y-2 border-t pt-4'>
                <h3 className='text-sm font-semibold'>Reporting limitations</h3>
                {data.unavailableMetrics.map(({ metric, reason }) => (
                  <p key={metric} className='text-sm text-muted-foreground'>
                    {metricLabels[metric] ?? 'Additional metric'}:{' '}
                    {reasonLabels[reason] ??
                      'Unavailable under the current reporting policy.'}
                  </p>
                ))}
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
