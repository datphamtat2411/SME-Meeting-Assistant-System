import { AlertCircle, Inbox, LoaderCircle, RefreshCw } from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
import {
  requestErrorKey,
  requestStatusErrorKey,
} from '@/lib/i18n/presentation'
import { Button } from '@/components/ui/button'

export function RequestLoading({ label }: { label?: string }) {
  const { t } = useUiTranslation()
  return (
    <div
      role='status'
      className='flex min-h-40 items-center justify-center gap-3 text-sm text-muted-foreground'
    >
      <LoaderCircle className='size-5 animate-spin' />
      {label ?? t('loading')}
    </div>
  )
}

export function RequestError({
  error,
  retry,
}: {
  error: unknown
  retry?: () => void
}) {
  const { t } = useUiTranslation()
  const failure = normalizeCoreApiError(error)
  const key = requestErrorKey(failure)
  const statusKey = key ? undefined : requestStatusErrorKey(failure.status)
  const message = key ? t(key) : statusKey ? t(statusKey) : failure.message
  const detail =
    statusKey && failure.message !== message ? failure.message : undefined
  return (
    <div
      role='alert'
      className='flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5'
    >
      <div className='flex gap-2 text-sm'>
        <AlertCircle className='size-5 shrink-0 text-destructive' />
        <div className='space-y-1'>
          <p>{message}</p>
          {detail && <p className='text-muted-foreground'>{detail}</p>}
        </div>
      </div>
      {retry && (
        <Button size='sm' variant='outline' onClick={retry}>
          <RefreshCw className='size-4' /> {t('retry')}
        </Button>
      )}
    </div>
  )
}

export function RequestEmpty({
  title,
  description,
}: {
  title?: string
  description?: string
}) {
  const { t } = useUiTranslation()
  return (
    <div className='flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center'>
      <Inbox className='size-7 text-muted-foreground' />
      <p className='font-medium'>{title ?? t('empty')}</p>
      {description && (
        <p className='text-sm text-muted-foreground'>{description}</p>
      )}
    </div>
  )
}
