import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMeetingSession } from './meeting-session-context'

function formatTime(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '--:--'
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(
    seconds % 60
  ).padStart(2, '0')}`
}

/**
 * UI for the single meeting-scoped playback engine. The element itself stays
 * mounted at MeetingSessionProvider; these controls can therefore be reused
 * by Detail, Live Meeting, and later transcript surfaces.
 */
export function PlaybackControls() {
  const session = useMeetingSession()
  const playback = session.playback
  if (playback.kind === 'idle') return null

  const active = playback.status === 'playing'
  const canSeek =
    playback.durationMs !== null && Number.isFinite(playback.durationMs)

  return (
    <div className='space-y-2 rounded-lg border bg-muted/10 p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='min-w-0 truncate text-sm font-medium'>
          {playback.kind === 'local' ? 'Local preview' : 'Source playback'}:{' '}
          {playback.filename ?? 'recording'}
        </p>
        <span className='text-xs text-muted-foreground'>
          {playback.status === 'loading'
            ? 'Loading…'
            : playback.status === 'waiting'
              ? 'Buffering…'
              : playback.status === 'error'
                ? 'Playback unavailable'
                : playback.status === 'ended'
                  ? 'Finished'
                  : playback.status === 'paused'
                    ? 'Paused'
                    : ''}
        </span>
      </div>
      {playback.error && (
        <p role='alert' className='text-sm text-destructive'>
          {playback.error}
        </p>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={playback.isLoading || !playback.objectUrl}
          onClick={() => void (active ? session.pause() : session.play())}
          aria-label={active ? 'Pause playback' : 'Play playback'}
        >
          {active ? <Pause className='size-4' /> : <Play className='size-4' />}
          {active ? 'Pause' : 'Play'}
        </Button>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          onClick={session.stopPlayback}
          aria-label='Stop playback'
        >
          <Square className='size-4' />
          Stop
        </Button>
        <span className='text-xs text-muted-foreground tabular-nums'>
          {formatTime(playback.currentTimeMs)} /{' '}
          {formatTime(playback.durationMs)}
        </span>
      </div>
      <input
        type='range'
        min={0}
        max={playback.durationMs ?? 0}
        step={100}
        value={Math.min(playback.currentTimeMs, playback.durationMs ?? 0)}
        disabled={!canSeek}
        onChange={(event) => session.seek(Number(event.target.value))}
        aria-label={`Seek ${playback.filename ?? 'audio'}`}
        className='w-full accent-primary'
      />
      <label className='flex items-center gap-2 text-xs text-muted-foreground'>
        Speed
        <select
          value={String(playback.playbackRate)}
          onChange={(event) =>
            session.setPlaybackRate(Number(event.target.value))
          }
          className='rounded border bg-background px-1.5 py-1 text-foreground'
          aria-label='Playback speed'
        >
          {[0.5, 1, 1.25, 1.5, 2].map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
