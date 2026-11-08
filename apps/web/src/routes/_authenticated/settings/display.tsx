import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/settings/display')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/appearance', replace: true })
  },
})
