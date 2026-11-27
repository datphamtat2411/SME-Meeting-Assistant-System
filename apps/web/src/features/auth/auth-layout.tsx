import { Logo } from '@/assets/logo'
import { LanguageSwitcher } from '@/components/language-switcher'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='container grid min-h-svh max-w-none grid-cols-1 items-center justify-items-center'>
      <div className='fixed inset-e-4 top-4'>
        <LanguageSwitcher />
      </div>
      <div className='mx-auto flex w-full max-w-md flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-4 flex items-center justify-center'>
          <Logo className='me-2' />
          <h1 className='text-xl font-medium'>SME Meeting Assistant</h1>
        </div>
        {children}
      </div>
    </div>
  )
}
