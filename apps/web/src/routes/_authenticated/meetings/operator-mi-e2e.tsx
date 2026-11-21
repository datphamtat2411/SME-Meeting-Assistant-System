import { createFileRoute } from '@tanstack/react-router'
import { OperatorMiE2eWorkspace } from '@/features/meetings/operator-mi-e2e-workspace'

export const Route = createFileRoute(
  '/_authenticated/meetings/operator-mi-e2e'
)({
  component: OperatorMiE2eWorkspace,
})
