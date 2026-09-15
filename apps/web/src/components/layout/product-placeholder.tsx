import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'

type ProductPlaceholderProps = {
  title: string
  description: string
}

export function ProductPlaceholder({
  title,
  description,
}: ProductPlaceholderProps) {
  return (
    <>
      <Header />
      <Main>
        <div className='space-y-2'>
          <h1 className='text-2xl font-bold tracking-tight'>{title}</h1>
          <p className='text-muted-foreground'>{description}</p>
        </div>
      </Main>
    </>
  )
}
