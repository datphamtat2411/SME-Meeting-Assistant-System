import { createFileRoute } from '@tanstack/react-router'
import { NotFoundError } from '@/features/errors/not-found-error'
import { Settings } from '@/features/settings'

export const Route = createFileRoute('/_authenticated/settings')({
  component: Settings,
  notFoundComponent: SettingsNotFound,
})

function SettingsNotFound() {
  return <NotFoundError className='min-h-full' />
}
