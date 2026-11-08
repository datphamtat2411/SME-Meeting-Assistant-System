import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'

export function HelpCenter() {
  return (
    <>
      <Header fixed className='border-b'>
        <HeaderActions />
      </Header>
      <Main fixed className='flex-1 items-center justify-center'>
        <div className='mx-auto flex max-w-lg flex-col items-center gap-4 text-center'>
          <h1 className='text-2xl font-bold tracking-tight'>Help Center</h1>
          <p className='text-muted-foreground'>
            Help Center content is not available in this workspace yet. Use the
            dashboard to continue with your meeting work.
          </p>
          <Button asChild>
            <Link to='/'>Return to Dashboard</Link>
          </Button>
        </div>
      </Main>
    </>
  )
}
