import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/meetings/')({
  component: MeetingsPlaceholder,
})

function MeetingsPlaceholder() {
  return (
    <ProductPlaceholder
      title='Meetings'
      description='Meeting management will be available here.'
    />
  )
}
