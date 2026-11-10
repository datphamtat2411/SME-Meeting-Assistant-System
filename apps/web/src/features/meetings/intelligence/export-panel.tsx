import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { RequestError } from '@/components/request-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { accessMinutesExport, createMinutesExport, exportStatusQuery, type ExportStatus } from './export-api'
import { minutesQuery } from './minutes-api'

export function ExportPanel({ meetingId }: { meetingId: string }) {
  const [exportId, setExportId] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const minutes = useQuery(minutesQuery(meetingId))
  const status = useQuery({ ...exportStatusQuery(exportId), enabled: Boolean(exportId),
    refetchInterval: query => { const value = query.state.data as ExportStatus | undefined; return !value || value.status === 'PENDING' || value.status === 'GENERATING' ? 4000 : false } })
  const create = useMutation({
    mutationFn: (format: 'PDF' | 'MARKDOWN') => createMinutesExport(meetingId, format),
    onSuccess: data => { setExportId(data.exportId); toast.success('Export queued') },
    onError: e => {
      if (normalizeCoreApiError(e).status === 404) setUnavailable(true)
      toast.error('Export request unavailable', { description: e instanceof Error ? e.message : undefined })
    },
  })
  const download = useMutation({
    mutationFn: async () => {
      const result = await accessMinutesExport(exportId)
      if (result.freshness !== 'CURRENT') throw new Error('Export is not current. Generate a fresh copy.')
      const url = new URL(result.accessUrl)
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('Refusing unsafe download URL')
      window.open(result.accessUrl, '_blank', 'noopener,noreferrer')
    },
    onError: e => toast.error('Download unavailable', { description: e instanceof Error ? e.message : undefined }),
  })
  return <Card><CardHeader><CardTitle className='flex items-center gap-2'><FileDown className='size-5' />Export meeting minutes</CardTitle><p className='text-sm text-muted-foreground'>Exports require a complete, reviewed minutes snapshot. Server-side export admission may be disabled by deployment policy.</p></CardHeader><CardContent className='space-y-3'>
    {unavailable ? <p className='text-sm text-muted-foreground'>Durable exports are not enabled on this backend deployment.</p> : <div className='flex flex-wrap gap-2'><Button size='sm' variant='outline' disabled={create.isPending || minutes.data?.completeness !== 'COMPLETE'} onClick={() => create.mutate('MARKDOWN')}>Generate Markdown</Button><Button size='sm' disabled={create.isPending || minutes.data?.completeness !== 'COMPLETE'} onClick={() => create.mutate('PDF')}>Generate PDF</Button></div>}
    {minutes.data && minutes.data.completeness !== 'COMPLETE' && <p className='text-sm text-amber-700'>Minutes are {minutes.data.completeness}. Review missing or stale content first.</p>}
    {minutes.isError && <RequestError error={minutes.error} retry={() => void minutes.refetch()} />}
    {status.isError && <RequestError error={status.error} retry={() => void status.refetch()} />}
    {status.data && <div className='flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm'><span>Export {status.data.format}</span><Badge variant='outline'>{status.data.status}</Badge><Badge variant='outline'>{status.data.freshness}</Badge>
      {status.data.safeErrorCode && <span className='text-destructive'>{status.data.safeErrorCode}</span>}
      {status.data.status === 'READY' && status.data.freshness === 'CURRENT' && <Button size='sm' disabled={download.isPending} onClick={() => download.mutate()}><Download className='size-4' /> Download</Button>}
    </div>}
  </CardContent></Card>
}
