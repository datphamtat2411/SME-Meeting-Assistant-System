import { createFileRoute, useLocation } from '@tanstack/react-router'
import { Otp } from '@/features/auth/otp'

export const Route = createFileRoute('/(auth)/otp')({
  component: function CallbackPage() {
    const navigationKey = useLocation({
      select: (location) => location.state.__TSR_key ?? location.state.key,
    })
    return <Otp key={navigationKey} />
  },
})
