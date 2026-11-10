import { AlertCircle, Inbox, LoaderCircle, RefreshCw } from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'

export function RequestLoading({ label = 'Loading workspace data…' }: { label?: string }) {
  return <div role='status' className='flex min-h-40 items-center justify-center gap-3 text-sm text-muted-foreground'><LoaderCircle className='size-5 animate-spin' />{label}</div>
}

export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  const failure = normalizeCoreApiError(error)
  const message = failure.status === 403 ? 'You do not have permission to access this resource.' :
    failure.status === 404 ? 'The requested resource was not found.' :
    failure.isNetworkError ? 'The server is unreachable. Check your connection.' :
    failure.status === 412 ? 'This item has changed. Reload before editing.' :
    failure.message
  return <div role='alert' className='flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5'>
    <div className='flex gap-2 text-sm'><AlertCircle className='size-5 shrink-0 text-destructive' /><span>{message}</span></div>
    {retry && <Button size='sm' variant='outline' onClick={retry}><RefreshCw className='size-4' /> Retry</Button>}
  </div>
}

export function RequestEmpty({ title = 'No records found', description }: { title?: string; description?: string }) {
  return <div className='flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center'>
    <Inbox className='size-7 text-muted-foreground' /><p className='font-medium'>{title}</p>
    {description && <p className='text-sm text-muted-foreground'>{description}</p>}
  </div>
}
