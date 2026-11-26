import { createFileRoute, useLocation } from '@tanstack/react-router'
import { PasswordReset } from '@/features/auth/reset-password'

export const Route = createFileRoute('/(auth)/otp')({
  component: function CallbackPage() {
    const navigationKey = useLocation({
      select: (location) => location.state.__TSR_key ?? location.state.key,
    })
    return <PasswordReset key={navigationKey} />
  },
})
