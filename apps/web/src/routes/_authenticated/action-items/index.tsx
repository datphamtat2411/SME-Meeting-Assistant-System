import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/action-items/')({
  component: ActionItemsPlaceholder,
})

function ActionItemsPlaceholder() {
  return (
    <ProductPlaceholder
      title='Action Items'
      description='Action-item tracking will be available here.'
    />
  )
}
