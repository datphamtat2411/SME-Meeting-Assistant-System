import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
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
  createDecision,
  decisionsQuery,
  editDecision,
  reviewDecision,
  type Decision,
} from './decision-api'
import { invalidateMeetingArtifacts } from './query-invalidation'

export function DecisionsPanel({
  meetingId,
  canManageDecisions,
}: {
  meetingId: string
  canManageDecisions: boolean
}) {
  const qc = useQueryClient()
  const canManageRef = useRef(canManageDecisions)
  useEffect(() => {
    canManageRef.current = canManageDecisions
  }, [canManageDecisions])
  const query = useQuery(decisionsQuery(meetingId))
  const [editing, setEditing] = useState<Decision | null>(null)
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  function refresh() {
    invalidateMeetingArtifacts(qc, meetingId)
  }
  const mutation = useMutation({
    mutationFn: () => {
      if (!canManageRef.current) {
        throw new Error('Decision management is no longer authorized.')
      }
      return editing
        ? editDecision(editing, content.trim())
        : createDecision(meetingId, content.trim())
    },
    onSuccess: () => {
      toast.success('Decision saved')
      setEditing(null)
      setCreating(false)
      setContent('')
      refresh()
    },
    onError: (e) =>
      toast.error('Unable to save decision', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })
  const review = useMutation({
    mutationFn: ({
      item,
      command,
    }: {
      item: Decision
      command: 'confirm' | 'reject'
    }) => {
      if (!canManageRef.current) {
        throw new Error('Decision review is no longer authorized.')
      }
      return reviewDecision(item, command)
    },
    onSuccess: () => {
      toast.success('Decision reviewed')
      refresh()
    },
    onError: (e) => {
      toast.error('Review rejected', {
        description: e instanceof Error ? e.message : undefined,
      })
      refresh()
    },
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    if (canManageRef.current && content.trim()) mutation.mutate()
  }
  return (
    <Card>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3'>
        <div>
          <CardTitle>Key decisions</CardTitle>
          <p className='mt-1 text-sm text-muted-foreground'>
            AI proposals require explicit human confirmation.
          </p>
        </div>
        {canManageDecisions && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setEditing(null)
              setContent('')
              setCreating(true)
            }}
          >
            Add decision
          </Button>
        )}
      </CardHeader>
      <CardContent className='space-y-3'>
        {query.isPending ? (
          <RequestLoading />
        ) : query.isError ? (
          <RequestError
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : !query.data.items.length ? (
          <RequestEmpty title='No decisions recorded' />
        ) : (
          query.data.items.map((item) => (
            <div key={item.id} className='rounded-lg border p-3'>
              <div className='flex flex-wrap items-center gap-2'>
                <Badge
                  variant={
                    item.status === 'CONFIRMED' ? 'secondary' : 'outline'
                  }
                >
                  {item.status}
                </Badge>
                <Badge variant='outline'>{item.sourceType}</Badge>
                {item.isStale && <Badge variant='destructive'>Stale</Badge>}
              </div>
              <p className='my-2 text-sm whitespace-pre-wrap'>{item.content}</p>
              {item.aiUncertainty && (
                <p className='text-xs text-amber-600'>{item.aiUncertainty}</p>
              )}
              {canManageDecisions && (
                <div className='flex flex-wrap gap-2'>
                  {item.status === 'PROPOSED' && (
                    <>
                      <Button
                        size='sm'
                        disabled={review.isPending}
                        onClick={() =>
                          review.mutate({ item, command: 'confirm' })
                        }
                      >
                        Confirm
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={review.isPending}
                        onClick={() =>
                          review.mutate({ item, command: 'reject' })
                        }
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => {
                      setEditing(item)
                      setCreating(false)
                      setContent(item.content)
                    }}
                  >
                    Edit
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
        {canManageDecisions && (editing || creating) && (
          <form onSubmit={submit} className='space-y-2 rounded-lg border p-3'>
            <h4 className='font-medium'>
              {editing ? 'Edit decision' : 'New decision'}
            </h4>
            <Textarea
              rows={3}
              required
              maxLength={5000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className='flex gap-2'>
              <Button
                size='sm'
                disabled={mutation.isPending || !content.trim()}
              >
                Save
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => {
                  setEditing(null)
                  setCreating(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {query.data && query.data.page.hasNext && (
          <p className='text-xs text-amber-700'>
            More decisions exist. Showing the first 100 records.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
