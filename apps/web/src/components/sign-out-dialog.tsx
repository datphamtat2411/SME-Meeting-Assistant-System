import { useNavigate, useLocation } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { beginAuthLifecycleLogout } from '@/features/auth/session/auth-lifecycle'
import { useAuthLifecycleState } from '@/features/auth/session/logout-status'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const { t } = useUiTranslation()
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
      title={t('signOut')}
      desc={t('signOutDesc')}
      confirmText={isPending ? t('signingOut') : t('signOut')}
      destructive
      isLoading={isPending}
      handleConfirm={handleSignOut}
      className='sm:max-w-sm'
    />
  )
}
