import { Link } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'

export function HelpCenter() {
  const { t } = useUiTranslation()
  return (
    <>
      <Header fixed className='border-b'>
        <HeaderActions />
      </Header>
      <Main fixed className='flex-1 items-center justify-center'>
        <div className='mx-auto flex max-w-lg flex-col items-center gap-4 text-center'>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('help-center:title')}
          </h1>
          <p className='text-muted-foreground'>
            {t('help-center:unavailable')}
          </p>
          <Button asChild>
            <Link to='/'>{t('help-center:returnToDashboard')}</Link>
          </Button>
        </div>
      </Main>
    </>
  )
}
