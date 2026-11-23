import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { meetingListQueryOptions } from '@/features/meetings/data/list-api'

export function AssistantPage() {
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const result = useQuery(
    meetingListQueryOptions({ q, page, pageSize: 20, sort: 'createdAt,desc' })
  )
  function submit(e: FormEvent) {
    e.preventDefault()
    setPage(1)
    setQ(input.trim())
  }
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div>
          <p className='text-sm font-medium text-primary'>
            Knowledge discovery
          </p>
          <h1 className='flex items-center gap-2 text-3xl font-bold'>
            <Bot className='size-7' /> AI Assistant & search
          </h1>
          <p className='mt-2 text-muted-foreground'>
            Search meeting metadata you are authorized to see.
          </p>
        </div>
        <Card className='border-amber-200'>
          <CardHeader>
            <CardTitle>RAG questions are not available yet</CardTitle>
            <p className='text-sm text-muted-foreground'>
              The current Core API branch does not expose a public Assistant
              conversation/ask contract. Answers will not be fabricated locally
              or sent directly to the internal AI service. Search remains
              available through the authorized meetings API.
            </p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Search meetings</CardTitle>
            <form className='flex gap-2' onSubmit={submit}>
              <Input
                aria-label='Search meeting titles'
                placeholder='Search by meeting title or description'
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <Button type='submit'>
                <Search className='size-4' /> Search
              </Button>
            </form>
          </CardHeader>
          <CardContent className='space-y-3'>
            {result.isPending ? (
              <RequestLoading />
            ) : result.isError ? (
              <RequestError
                error={result.error}
                retry={() => void result.refetch()}
              />
            ) : !result.data.meetings.length ? (
              <RequestEmpty title='No accessible meetings match' />
            ) : (
              result.data.meetings.map((meeting) => (
                <Link
                  className='block rounded-lg border p-3 hover:bg-accent'
                  key={meeting.id}
                  to='/meetings/$meetingId'
                  params={{ meetingId: meeting.id }}
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <strong>{meeting.title}</strong>
                    <Badge variant='outline'>{meeting.status}</Badge>
                  </div>
                  <p className='mt-1 line-clamp-2 text-sm text-muted-foreground'>
                    {meeting.description || 'No description provided'}
                  </p>
                </Link>
              ))
            )}
            {result.data && (
              <div className='flex items-center justify-between text-sm text-muted-foreground'>
                <span>{result.data.pagination.totalElements} result(s)</span>
                <div className='flex items-center gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!result.data.pagination.hasPrevious}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  {page}
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!result.data.pagination.hasNext}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
