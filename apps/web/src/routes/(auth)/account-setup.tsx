import { createFileRoute } from '@tanstack/react-router'
import { AccountSetup } from '@/features/auth/account-setup'

export const Route = createFileRoute('/(auth)/account-setup')({
  component: AccountSetup,
})
