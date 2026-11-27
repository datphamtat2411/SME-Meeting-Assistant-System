import { createFileRoute } from '@tanstack/react-router'
import { AssistantPage } from '@/features/assistant'
import { parseAssistantSelection } from '@/features/assistant/assistant-selection'

export const Route = createFileRoute('/_authenticated/assistant/')({
  validateSearch: parseAssistantSelection,
  component: AssistantRoute,
})

function AssistantRoute() {
  const selection = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AssistantPage
      selection={selection}
      onSelectionChange={(search) => void navigate({ search })}
    />
  )
}
