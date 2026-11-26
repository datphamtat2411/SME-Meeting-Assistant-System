import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RequestError, RequestLoading } from '@/components/request-state'
import {
  preferencesMutationInput,
  preferencesQuery,
  usePreferencesMutation,
} from '../preferences-api'

export function NotificationsForm() {
  const query = useQuery(preferencesQuery())
  const mutation = usePreferencesMutation()
  function save(patch: { meetingEmailEnabled?: boolean; actionItemEmailEnabled?: boolean }) {
    mutation.mutate(preferencesMutationInput(patch), {
      onSuccess: () => toast.success('Notification preferences saved'),
      onError: (error) =>
        toast.error('Unable to save preferences', {
          description: error instanceof Error ? error.message : undefined,
        }),
    })
  }
  if (query.isPending) return <RequestLoading />
  if (query.isError)
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  return (
    <div className='max-w-xl space-y-6'>
      <div className='flex items-center justify-between gap-4 rounded-lg border p-4'>
        <div className='space-y-1'>
          <Label htmlFor='meeting-email'>Meeting emails</Label>
          <p className='text-sm text-muted-foreground'>
            Meeting invitations and schedule changes.
          </p>
        </div>
        <Switch
          id='meeting-email'
          checked={query.data.meetingEmailEnabled}
          disabled={mutation.isPending}
          onCheckedChange={(value) =>
            save({ meetingEmailEnabled: value })
          }
        />
      </div>
      <div className='flex items-center justify-between gap-4 rounded-lg border p-4'>
        <div className='space-y-1'>
          <Label htmlFor='action-email'>Action item emails</Label>
          <p className='text-sm text-muted-foreground'>
            Assignment and follow-up notifications.
          </p>
        </div>
        <Switch
          id='action-email'
          checked={query.data.actionItemEmailEnabled}
          disabled={mutation.isPending}
          onCheckedChange={(value) =>
            save({ actionItemEmailEnabled: value })
          }
        />
      </div>
    </div>
  )
}
