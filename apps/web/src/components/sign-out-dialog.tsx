import { useNavigate, useLocation } from '@tanstack/react-router'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { beginAuthLifecycleLogout } from '@/features/auth/session/auth-lifecycle'
import { useAuthLifecycleState } from '@/features/auth/session/logout-status'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const lifecycleState = useAuthLifecycleState()
  const isPending = lifecycleState === 'pending'

  const handleSignOut = () => {
    const currentPath = location.href
    if (isPending) return

    void beginAuthLifecycleLogout({
      redirect: currentPath,
      navigate: (redirect) => {
        navigate({
          to: '/sign-in',
          search: { redirect },
          replace: true,
        })
      },
    })
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Sign out'
      desc='Are you sure you want to sign out? You will need to sign in again to access your account.'
       confirmText={isPending ? 'Signing out...' : 'Sign out'}
       destructive
       isLoading={isPending}
       handleConfirm={handleSignOut}
      className='sm:max-w-sm'
    />
  )
}
