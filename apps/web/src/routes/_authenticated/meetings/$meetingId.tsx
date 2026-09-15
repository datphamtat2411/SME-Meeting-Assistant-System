import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { getMeetingById } from '@/features/meetings/data'

export const Route = createFileRoute('/_authenticated/meetings/$meetingId')({
  component: MeetingPlaceholder,
})

// eslint-disable-next-line react-refresh/only-export-components
function MeetingPlaceholder() {
  const { meetingId } = Route.useParams()
  const meeting = getMeetingById(meetingId)

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main>
        <div className='mb-4'>
          <Button asChild variant='ghost' className='-ms-3'>
            <Link to='/meetings'>
              <ArrowLeft />
              Back to Meetings
            </Link>
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{meeting?.title ?? 'Meeting'}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-muted-foreground'>
              Meeting workspace will be implemented in a later task.
            </p>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
