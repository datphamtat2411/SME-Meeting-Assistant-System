import { useLayoutEffect } from 'react'
import { Logo } from '@/assets/logo'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash) return

    // Capability links use a fragment so the token is never sent to Core.
    // Remove it before the callback page paints or can be bookmarked.
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search
    )
  }, [])

  return (
    <div className='container grid h-svh max-w-none items-center justify-center'>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-4 flex items-center justify-center'>
          <Logo className='me-2' />
          <h1 className='text-xl font-medium'>SME Meeting Assistant</h1>
        </div>
        {children}
      </div>
    </div>
  )
}
