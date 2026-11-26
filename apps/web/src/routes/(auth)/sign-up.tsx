import { createFileRoute, useLocation } from '@tanstack/react-router'
import { SignUp } from '@/features/auth/sign-up'

export const Route = createFileRoute('/(auth)/sign-up')({
  component: function CallbackPage() {
    const navigationKey = useLocation({
      select: (location) => location.state.__TSR_key ?? location.state.key,
    })
    return <SignUp key={navigationKey} />
  },
})
