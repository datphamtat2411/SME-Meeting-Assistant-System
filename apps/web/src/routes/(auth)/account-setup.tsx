import { createFileRoute, useLocation } from '@tanstack/react-router'
import { AccountSetup } from '@/features/auth/account-setup'

export const Route = createFileRoute('/(auth)/account-setup')({
  component: function CallbackPage() {
    const navigationKey = useLocation({
      select: (location) => location.state.__TSR_key ?? location.state.key,
    })
    return <AccountSetup key={navigationKey} />
  },
})
