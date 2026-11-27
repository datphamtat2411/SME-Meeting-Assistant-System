import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Check, RefreshCw, Users } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  meetingScheduleCheckQueryOptions,
  type ScheduleCheckInput,
  type ScheduleCheckResult,
} from '../data/meeting-creation-api'

export function SelectedRoomSchedulePreview({
  input,
  roomName,
}: {
  input: ScheduleCheckInput
  roomName?: string
}) {
  const options = meetingScheduleCheckQueryOptions(input)
  const fingerprint = JSON.stringify(options.queryKey)
  const [debouncedFingerprint, setDebouncedFingerprint] = useState<
    string | null
  >(null)

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedFingerprint(fingerprint),
      250
    )
    return () => window.clearTimeout(timeout)
  }, [fingerprint])

  const ready = debouncedFingerprint === fingerprint
  const query = useQuery({ ...options, enabled: ready })

  if (!ready || query.isFetching || (query.isPending && !query.isError)) {
    return (
      <div
        role='status'
        aria-live='polite'
        className='flex items-center gap-2 text-xs text-muted-foreground'
      >
        <span className='size-4 animate-spin rounded-full border-2 border-current border-e-transparent' />
        Checking {roomName ?? 'selected room'} for this interval...
      </div>
    )
  }

  if (query.isError) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Room schedule could not be checked</AlertTitle>
        <AlertDescription>
          <p>
            Availability is unknown, not available. Retry the read-only check;
            scheduling remains subject to Core API validation.
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Retry room check
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (!query.data) return null

  return (
    <RoomScheduleResult
      result={query.data}
      roomName={roomName}
      onRetry={() => void query.refetch()}
    />
  )
}

function RoomScheduleResult({
  result,
  roomName,
  onRetry,
}: {
  result: ScheduleCheckResult
  roomName?: string
  onRetry: () => void
}) {
  const room = result.room
  const conflict =
    result.roomConflict || room?.active === false || room?.available === false
  const blocked =
    !result.previewOnly || !result.canSchedule || conflict || !room
  const title = conflict
    ? room?.active === false
      ? 'Selected room is inactive'
      : `${roomName ?? 'Selected room'} conflicts with another meeting`
    : !room
      ? 'Selected room availability could not be confirmed'
      : !result.previewOnly || !result.canSchedule
        ? 'Schedule preview did not approve this interval'
        : `${roomName ?? 'Selected room'} appears available`

  const advisories = [...result.warnings]
  if (
    room?.capacityExceeded &&
    !advisories.some((warning) => warning.code === 'CAPACITY_ADVISORY_EXCEEDED')
  ) {
    advisories.push({ code: 'CAPACITY_ADVISORY_EXCEEDED', userId: null })
  }

  return (
    <Alert variant={blocked ? 'destructive' : 'default'}>
      {blocked ? <AlertCircle /> : <Check />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          Preview only. Core API rechecks room reservations when a meeting is
          changed; this result does not authorize a save or schedule.
        </p>
        {room?.capacityExceeded && (
          <p className='flex items-center gap-1'>
            <Users className='size-4' />
            Configured capacity ({room.capacity ?? 'unknown'}) is below the
            checked participant count ({room.participantCount ?? 'unknown'}).
            This advisory does not block scheduling when Core API permits it.
          </p>
        )}
        {advisories.length > 0 && (
          <ul aria-label='Room schedule advisories' className='list-disc ps-5'>
            {advisories.map((warning, index) => (
              <li key={`${warning.code}-${warning.userId ?? 'all'}-${index}`}>
                {formatWarning(warning.code)}
              </li>
            ))}
          </ul>
        )}
        {blocked && (
          <Button type='button' variant='outline' size='sm' onClick={onRetry}>
            <RefreshCw />
            Retry room check
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function formatWarning(code: string) {
  if (code === 'CAPACITY_ADVISORY_EXCEEDED') return 'Room capacity advisory.'
  if (code === 'PARTICIPANT_OVERLAP')
    return 'Participant schedule overlap warning.'
  return `Schedule warning: ${code}`
}
