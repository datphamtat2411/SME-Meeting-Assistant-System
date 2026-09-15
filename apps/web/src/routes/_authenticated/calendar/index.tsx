import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/calendar/')({
  component: CalendarPlaceholder,
})

function CalendarPlaceholder() {
  return (
    <ProductPlaceholder
      title='Calendar'
      description='Meeting scheduling and calendar views will be available here.'
    />
  )
}
