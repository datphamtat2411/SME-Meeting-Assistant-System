import { i18n, useUiTranslation } from '@/lib/i18n'
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
  const { t } = useUiTranslation()
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
        {t('meetings:schedule_checkingRoom', { room: roomName ?? t('meetings:schedule_selectedRoomLower') })}
      </div>
    )
  }

  if (query.isError) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>{t('meetings:schedule_roomCheckFailed')}</AlertTitle>
        <AlertDescription>
          <p>
            {t('meetings:schedule_roomCheckUnknown')}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            {t('meetings:schedule_retryRoomCheck')}
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
  const { t } = useUiTranslation()
  const room = result.room
  const conflict =
    result.roomConflict || room?.active === false || room?.available === false
  const blocked =
    !result.previewOnly || !result.canSchedule || conflict || !room
  const title = conflict
    ? room?.active === false
      ? t('meetings:schedule_roomInactive')
      : t('meetings:schedule_roomConflict', { room: roomName ?? t('meetings:schedule_selectedRoomTitle') })
    : !room
      ? t('meetings:schedule_roomUnconfirmed')
      : !result.previewOnly || !result.canSchedule
        ? t('meetings:schedule_intervalNotApproved')
        : t('meetings:schedule_roomAppearsAvailable', { room: roomName ?? t('meetings:schedule_selectedRoomTitle') })

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
          {t('meetings:schedule_roomPreviewOnly')}
        </p>
        {room?.capacityExceeded && (
          <p className='flex items-center gap-1'>
            <Users className='size-4' />
            {t('meetings:schedule_capacityHint', { capacity: room.capacity ?? t('meetings:schedule_unknownCapacity'), participants: room.participantCount ?? t('meetings:schedule_unknownCapacity') })}
          </p>
        )}
        {advisories.length > 0 && (
          <ul aria-label={t('meetings:schedule_roomAdvisories')} className='list-disc ps-5'>
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
            {t('meetings:schedule_retryRoomCheck')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function formatWarning(code: string) {
  if (code === 'CAPACITY_ADVISORY_EXCEEDED') return i18n.t('meetings:schedule_capacityAdvisory')
  if (code === 'PARTICIPANT_OVERLAP')
    return i18n.t('meetings:schedule_participantOverlap')
  return i18n.t('meetings:schedule_unknownWarning', { code })
}
