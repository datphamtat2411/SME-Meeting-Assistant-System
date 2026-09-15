import { createFileRoute } from '@tanstack/react-router'
import { MeetingsPage } from '@/features/meetings'

export const Route = createFileRoute('/_authenticated/meetings/')({
  component: MeetingsPage,
})
