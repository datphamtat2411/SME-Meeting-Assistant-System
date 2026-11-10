import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  activateSummary,
  editSummary,
  regenerateSummary,
  summaryQuery,
  summaryVersionsQuery,
} from './summary-api'

export function SummaryPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const summary = useQuery(summaryQuery(meetingId))
  const versions = useQuery({
    ...summaryVersionsQuery(meetingId),
    enabled: summary.isSuccess,
  })
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  function refresh() {
    void qc.invalidateQueries({ queryKey: ['meeting-intelligence', meetingId] })
  }
  const save = useMutation({
    mutationFn: () => editSummary(meetingId, content.trim()),
    onSuccess: () => {
      toast.success('New summary version saved')
      setEditing(false)
      refresh()
    },
    onError: (e) =>
      toast.error('Cannot save summary', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  const activate = useMutation({
    mutationFn: (id: string) => activateSummary(meetingId, id),
    onSuccess: () => {
      toast.success('Summary version activated')
      refresh()
    },
    onError: (e) =>
      toast.error('Could not activate version', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  const regenerate = useMutation({
    mutationFn: () => regenerateSummary(meetingId),
    onSuccess: () => {
      toast.success('Summary regeneration queued')
      refresh()
    },
    onError: (e) =>
      toast.error('Could not request regeneration', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Meeting summary</CardTitle>
        <p className='text-sm text-muted-foreground'>
          AI-generated text is derived content. Review before treating it as a
          meeting record.
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {summary.isPending ? (
          <RequestLoading />
        ) : summary.isError ? (
          normalizeCoreApiError(summary.error).status === 404 ? (
            <RequestEmpty title='No summary available' />
          ) : (
            <RequestError
              error={summary.error}
              retry={() => void summary.refetch()}
            />
          )
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant='outline'>{summary.data.qualityStatus}</Badge>
              <Badge variant='secondary'>{summary.data.sourceType}</Badge>
              <span className='text-xs text-muted-foreground'>
                Version {summary.data.versionNumber}
              </span>
              {summary.data.isStale && (
                <Badge variant='destructive'>Stale source</Badge>
              )}
            </div>
            {summary.data.aiWarnings?.map((warning, index) => (
              <p key={index} className='text-sm text-amber-600'>
                {warning}
              </p>
            ))}
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (content.trim()) save.mutate()
                }}
                className='space-y-2'
              >
                <Textarea
                  rows={8}
                  maxLength={20000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                <div className='flex gap-2'>
                  <Button disabled={save.isPending}>Save version</Button>
                  <Button
                    type='button'
                    variant='outline'
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p className='text-sm leading-7 whitespace-pre-wrap'>
                {summary.data.content}
              </p>
            )}
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={editing}
                onClick={() => {
                  setContent(summary.data.content)
                  setEditing(true)
                }}
              >
                Edit summary
              </Button>
              <Button
                size='sm'
                variant='secondary'
                disabled={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                Regenerate
              </Button>
            </div>
            {versions.data && versions.data.items.length > 1 && (
              <div className='space-y-2 border-t pt-3'>
                <h4 className='text-sm font-semibold'>Version history</h4>
                {versions.data.items.map((version) => (
                  <div
                    key={version.id}
                    className='flex items-center justify-between gap-2 text-sm'
                  >
                    <span>
                      Version {version.versionNumber} · {version.sourceType}
                      {version.isStale ? ' · stale' : ''}
                    </span>
                    {version.isCurrent ? (
                      <Badge>Current</Badge>
                    ) : (
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={activate.isPending}
                        onClick={() => activate.mutate(version.id)}
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
