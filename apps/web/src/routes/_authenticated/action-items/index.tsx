import { createFileRoute } from '@tanstack/react-router'
import { ActionItemsPage } from '@/features/action-items'

export const Route = createFileRoute('/_authenticated/action-items/')({
  component: ActionItemsPage,
})
