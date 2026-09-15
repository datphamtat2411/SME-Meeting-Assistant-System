import { createFileRoute } from '@tanstack/react-router'
import { AssistantPage } from '@/features/assistant'

export const Route = createFileRoute('/_authenticated/assistant/')({
  component: AssistantPage,
})
