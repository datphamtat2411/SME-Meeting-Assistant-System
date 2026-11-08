import { cn } from '@/lib/utils'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { UserMenu } from './user-menu'

export function HeaderActions({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'ms-auto flex min-w-0 max-w-full items-center gap-1 sm:gap-2',
        className
      )}
    >
      <Search className='min-w-0 flex-1 sm:flex-none' />
      <ThemeSwitch />
      <UserMenu />
    </div>
  )
}
