import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { getMemberById, type Member, type TranscriptSegment } from './data'

export function ParticipantAvatar({
  member,
  className,
}: {
  member: Member
  className?: string
}) {
  return (
    <Avatar className={cn('size-9', className)}>
      {member.avatar && <AvatarImage src={member.avatar} alt={member.name} />}
      <AvatarFallback className='bg-primary/10 text-xs font-medium text-primary'>
        {getInitials(member.name)}
      </AvatarFallback>
    </Avatar>
  )
}

export function TranscriptSegmentRow({
  segment,
  highlighted,
  mappedName,
}: {
  segment: TranscriptSegment
  highlighted: boolean
  mappedName?: string
}) {
  const participantId = segment.participantId
  const participant = participantId ? getMemberById(participantId) : undefined
  const speakerLabel = formatSpeakerLabel(segment.speakerLabel)

  return (
    <div
      id={`transcript-${segment.id}`}
      className={cn(
        'rounded-lg border p-4 transition-colors',
        highlighted && 'border-primary bg-primary/5 ring-2 ring-primary/30'
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-3'>
          {participant ? (
            <ParticipantAvatar member={participant} />
          ) : (
            <Avatar className='size-9'>
              <AvatarFallback className='bg-muted text-xs'>
                {speakerLabel.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          )}
          <div className='min-w-0'>
            <p className='truncate font-medium'>
              {mappedName?.trim() || participant?.name || speakerLabel}
            </p>
            <p className='text-xs text-muted-foreground'>
              {participant || mappedName?.trim()
                ? speakerLabel
                : 'Participant not mapped'}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Badge variant='outline' className='font-mono text-[11px]'>
            {formatTranscriptTimestamp(segment.startMs)}
          </Badge>
          {!segment.isFinal && (
            <Badge
              variant='outline'
              className='text-amber-700 dark:text-amber-300'
            >
              Draft
            </Badge>
          )}
        </div>
      </div>
      <p className='mt-4 leading-7 text-foreground/90'>{segment.text}</p>
    </div>
  )
}

function formatTranscriptTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatSpeakerLabel(label: string) {
  const match = /^SPEAKER_(\d+)$/i.exec(label)
  return match ? `Speaker ${Number(match[1])}` : label
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toLocaleUpperCase()
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toLocaleUpperCase()
}
