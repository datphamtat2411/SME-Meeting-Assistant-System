import { RegionalCivilDate } from '@/components/regional-timestamp'
import { useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { ExternalLink, ListChecks, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  actionItemsQuery,
  managementCapabilityQuery,
  type ActionFilter,
  type ActionItem,
  type ActionPage,
} from './action-api'
import { ActionCommands } from './action-commands'
import { ActionForm } from './action-form'

const filterFor = (
  meetingId: string,
  overrides: Partial<ActionFilter> = {}
): ActionFilter => ({
  page: 0,
  q: '',
  status: 'all',
  official: 'all',
  assignee: 'all',
  overdue: false,
  meetingId,
  sort: 'createdAt,desc',
  ...overrides,
})

export function MeetingActionsPanel({
  meetingId,
  canManageActionItems,
  resolveManagementCapability = false,
  canReadMeetingContent = true,
  onEvidenceNavigate,
}: {
  meetingId: string
  canManageActionItems: boolean
  resolveManagementCapability?: boolean
  canReadMeetingContent?: boolean
  onEvidenceNavigate?: (
    transcriptId: string,
    segmentId: string,
    contentRevision?: number
  ) => void
}) {
  const [view, setView] = useState<'proposals' | 'official' | 'history'>(
    'proposals'
  )
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ActionItem | null>(null)
  const management = useQuery({
    ...managementCapabilityQuery(meetingId),
    enabled: resolveManagementCapability && !canManageActionItems,
    refetchOnMount: 'always',
    staleTime: 0,
  })
  const canCreate =
    canManageActionItems ||
    (resolveManagementCapability &&
      management.isSuccess &&
      management.isFetchedAfterMount &&
      management.data.canCreate)
  return (
    <>
      <Card>
        <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3 border-b'>
          <div>
            <CardTitle className='flex items-center gap-2'>
              <ListChecks className='size-5' /> Meeting Action Items
            </CardTitle>
            <CardDescription>
              Review AI candidates, then manage the official follow-up
              obligations assembled for this meeting.
            </CardDescription>
          </div>
          {canCreate && (
            <Button
              size='sm'
              onClick={() => {
                setSelected(null)
                setOpen(true)
              }}
            >
              <Plus className='size-4' /> Add official work
            </Button>
          )}
        </CardHeader>
        <CardContent className='p-4 sm:p-6'>
          {resolveManagementCapability &&
            !canManageActionItems &&
            management.isError && (
              <div className='mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground'>
                Creation authority could not be verified.
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => void management.refetch()}
                >
                  Retry permission check
                </Button>
              </div>
            )}
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as typeof view)}
          >
            <TabsList className='mb-4'>
              <TabsTrigger value='proposals'>Proposal review</TabsTrigger>
              <TabsTrigger value='official'>Official follow-up</TabsTrigger>
              <TabsTrigger value='history'>Historical</TabsTrigger>
            </TabsList>
            <TabsContent value='proposals' className='mt-0'>
              <ProposalCollection
                meetingId={meetingId}
                onSelect={(item) => {
                  setSelected(item)
                  setOpen(true)
                }}
                canReadMeetingContent={canReadMeetingContent}
                onEvidenceNavigate={
                  canReadMeetingContent ? onEvidenceNavigate : undefined
                }
              />
            </TabsContent>
            <TabsContent value='official' className='mt-0'>
              <OfficialCollection
                meetingId={meetingId}
                onSelect={(item) => {
                  setSelected(item)
                  setOpen(true)
                }}
              />
            </TabsContent>
            <TabsContent value='history' className='mt-0'>
              <HistoryCollections meetingId={meetingId} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      {(open || selected?.capabilities.canEdit || canCreate) && (
        <ActionForm
          key={open ? (selected?.id ?? `new-${meetingId}`) : 'closed'}
          open={open}
          onOpenChange={setOpen}
          item={selected}
          meetingId={meetingId}
          canManageActionItems={canCreate}
        />
      )}
    </>
  )
}

function ProposalCollection({
  meetingId,
  onSelect,
  canReadMeetingContent,
  onEvidenceNavigate,
}: {
  meetingId: string
  onSelect: (item: ActionItem) => void
  canReadMeetingContent: boolean
  onEvidenceNavigate?: (
    transcriptId: string,
    segmentId: string,
    contentRevision?: number
  ) => void
}) {
  const { query, setPage } = useMeetingActionPage(meetingId, {
    official: false,
    status: 'PROPOSED',
  })
  if (query.isPending) return <RequestLoading />
  if (query.isError)
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  if (!query.data.items.length && query.data.page.page === 0)
    return (
      <RequestEmpty
        title='No proposals await review'
        description='AI candidates appear here until an authorized human confirms or rejects them.'
      />
    )
  return (
    <div className='space-y-3'>
      {query.data.items.map((item) => (
        <article
          key={item.id}
          className='space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4'
        >
          <div className='flex flex-wrap items-start justify-between gap-2'>
            <div>
              <h3 className='font-semibold'>{item.title}</h3>
              <p className='mt-1 text-sm text-muted-foreground'>
                {item.details ?? 'No proposed details.'}
              </p>
            </div>
            <Badge variant='outline'>AI proposal</Badge>
          </div>
          <div className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
            <span>Suggested due date: <RegionalCivilDate value={item.dueDate} fallback='none' /></span>
            <span>
              {item.assignee?.displayName
                ? `Suggested responsibility: ${item.assignee.displayName}`
                : 'Unassigned proposal'}
            </span>
            {canReadMeetingContent && item.capabilities.canAccessEvidence && (
              <span>Evidence: {item.evidence.references.length}</span>
            )}
          </div>
          {canReadMeetingContent && item.evidence.limitation && (
            <p className='text-sm text-amber-700'>{item.evidence.limitation}</p>
          )}
          {canReadMeetingContent &&
            item.evidence.references.length > 0 &&
            item.evidence.transcriptId &&
            item.capabilities.canAccessEvidence && (
              <div className='flex flex-wrap gap-2'>
                {item.evidence.references.map((reference, index) =>
                  onEvidenceNavigate ? (
                    <Button
                      key={reference.segmentId}
                      type='button'
                      size='sm'
                      variant='link'
                      className='h-auto px-0'
                      onClick={() =>
                        onEvidenceNavigate(
                          item.evidence.transcriptId!,
                          reference.segmentId,
                          item.evidence.contentRevision ?? undefined
                        )
                      }
                    >
                      Evidence {index + 1}{' '}
                      {reference.preview ? `· ${reference.preview}` : ''}{' '}
                      <ExternalLink className='size-3' />
                    </Button>
                  ) : (
                    <span
                      key={reference.segmentId}
                      className='text-xs text-muted-foreground'
                    >
                      Evidence {index + 1}
                    </span>
                  )
                )}
              </div>
            )}
          <div className='flex flex-wrap gap-2'>
            {item.capabilities.canEdit && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => onSelect(item)}
              >
                Correct proposal
              </Button>
            )}
            <ActionCommands item={item} />
          </div>
        </article>
      ))}
      <CollectionPager
        page={query.data.page}
        pageLabel='Proposal page'
        onPageChange={setPage}
      />
    </div>
  )
}

function OfficialCollection({
  meetingId,
  onSelect,
}: {
  meetingId: string
  onSelect: (item: ActionItem) => void
}) {
  const { query, setPage } = useMeetingActionPage(meetingId, {
    official: true,
  })
  return (
    <ActionListState
      query={query}
      onPageChange={setPage}
      onSelect={onSelect}
      empty='No official follow-up work for this meeting.'
    />
  )
}

function HistoryCollections({ meetingId }: { meetingId: string }) {
  const done = useMeetingActionPage(meetingId, {
    official: true,
    status: 'DONE',
  })
  const cancelled = useMeetingActionPage(meetingId, {
    official: true,
    status: 'CANCELLED',
  })
  const rejected = useMeetingActionPage(meetingId, {
    official: false,
    status: 'CANCELLED',
  })
  return (
    <div className='space-y-5'>
      <HistoryGroup
        title='Completed official work'
        query={done.query}
        onPageChange={done.setPage}
      />
      <HistoryGroup
        title='Cancelled official work'
        query={cancelled.query}
        onPageChange={cancelled.setPage}
      />
      <HistoryGroup
        title='Rejected proposals'
        query={rejected.query}
        onPageChange={rejected.setPage}
      />
    </div>
  )
}

function useMeetingActionPage(
  meetingId: string,
  filter: Partial<ActionFilter>
) {
  const [page, setPage] = useState(0)
  const query = useQuery(
    actionItemsQuery(filterFor(meetingId, { ...filter, page }))
  )
  if (query.data && page > Math.max(0, query.data.page.totalPages - 1)) {
    setPage(Math.max(0, query.data.page.totalPages - 1))
  }
  return { query, setPage }
}

type ActionItemsQuery = UseQueryResult<ActionPage, Error>

function HistoryGroup({
  title,
  query,
  onPageChange,
}: {
  title: string
  query: ActionItemsQuery
  onPageChange: (page: number) => void
}) {
  if (query.isPending)
    return (
      <section>
        <h3 className='mb-2 font-semibold'>{title}</h3>
        <RequestLoading />
      </section>
    )
  if (query.isError)
    return (
      <section>
        <h3 className='mb-2 font-semibold'>{title}</h3>
        <RequestError error={query.error} retry={() => void query.refetch()} />
      </section>
    )
  return (
    <section className='space-y-2'>
      <h3 className='font-semibold'>{title}</h3>
      {!query.data.items.length ? (
        <p className='text-sm text-muted-foreground'>
          No records in this collection.
        </p>
      ) : (
        <div className='space-y-2'>
          {query.data.items.map((item) => (
            <div
              key={item.id}
              className='flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm'
            >
              <span>{item.title}</span>
              <Badge variant={item.isOfficial ? 'secondary' : 'outline'}>
                {item.status}
              </Badge>
            </div>
          ))}
        </div>
      )}
      <CollectionPager
        page={query.data.page}
        pageLabel={title}
        onPageChange={onPageChange}
      />
    </section>
  )
}

function ActionListState({
  query,
  onSelect,
  empty,
  onPageChange,
}: {
  query: ActionItemsQuery
  onPageChange: (page: number) => void
  onSelect: (item: ActionItem) => void
  empty: string
}) {
  if (query.isPending) return <RequestLoading />
  if (query.isError)
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  if (!query.data.items.length && query.data.page.page === 0)
    return <RequestEmpty title={empty} />
  return (
    <div className='space-y-3'>
      {query.data.items.map((item) => (
        <section key={item.id} className='rounded-lg border p-4'>
          <div className='flex flex-wrap items-start justify-between gap-2'>
            <div>
              <h3 className='font-semibold'>{item.title}</h3>
              {item.details && (
                <p className='mt-1 text-sm whitespace-pre-wrap text-muted-foreground'>
                  {item.details}
                </p>
              )}
            </div>
            <Badge
              variant={
                item.status === 'CANCELLED'
                  ? 'destructive'
                  : item.status === 'DONE'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {item.status}
            </Badge>
          </div>
          <div className='mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground'>
            <span>
              Responsible: {item.assignee?.displayName ?? 'Unassigned'}
            </span>
            <span>Due: <RegionalCivilDate value={item.dueDate} fallback='none' /></span>
            {item.overdue && <Badge variant='destructive'>Overdue</Badge>}
          </div>
          <div className='mt-3 flex flex-wrap gap-2'>
            <ActionCommands item={item} />
            {item.capabilities.canEdit && (
              <Button size='sm' variant='ghost' onClick={() => onSelect(item)}>
                Edit
              </Button>
            )}
          </div>
        </section>
      ))}
      <CollectionPager
        page={query.data.page}
        pageLabel='Official work page'
        onPageChange={onPageChange}
      />
    </div>
  )
}

function CollectionPager({
  page,
  pageLabel,
  onPageChange,
}: {
  onPageChange: (page: number) => void
  page: { hasPrevious: boolean; hasNext: boolean; page: number }
  pageLabel: string
}) {
  return (
    <div className='flex items-center justify-between text-sm text-muted-foreground'>
      <span>
        {pageLabel} {page.page + 1}
      </span>
      <div className='flex gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={!page.hasPrevious}
          onClick={() => onPageChange(page.page - 1)}
        >
          Previous
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!page.hasNext}
          onClick={() => onPageChange(page.page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
