import { createFileRoute } from '@tanstack/react-router'
import { ProductPlaceholder } from '@/components/layout/product-placeholder'

export const Route = createFileRoute('/_authenticated/members/')({
  component: MembersPlaceholder,
})

function MembersPlaceholder() {
  return (
    <ProductPlaceholder
      title='Members'
      description='Workspace member management will be available here.'
    />
  )
}
