import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/rooms/')({
  component: RoomsPlaceholder,
})

function RoomsPlaceholder() {
  return (
    <ProductPlaceholder
      title='Meeting Rooms'
      description='Meeting room management will be available here.'
    />
  )
}
