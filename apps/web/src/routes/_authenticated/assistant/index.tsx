import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/assistant/')({
  component: AssistantPlaceholder,
})

function AssistantPlaceholder() {
  return (
    <ProductPlaceholder
      title='AI Assistant'
      description='Meeting knowledge assistance will be available here.'
    />
  )
}
