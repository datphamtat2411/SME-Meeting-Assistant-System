import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequestError, RequestLoading } from '@/components/request-state'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { myProfileQuery, updateMyProfile } from './profile-api'

export function ProfileForm() {
  const qc = useQueryClient()
  const query = useQuery(myProfileQuery())
  const [name, setName] = useState<string | null>(null)
  const displayName = name ?? query.data?.displayName ?? ''
  const mutation = useMutation({
    mutationFn: () => updateMyProfile(displayName.trim()),
    onSuccess: () => {
      toast.success('Profile updated')
      void qc.invalidateQueries({ queryKey: ['me', 'profile'] })
      void qc.invalidateQueries({ queryKey: currentUserQueryKey })
    },
    onError: (error) =>
      toast.error('Profile update failed', {
        description: error instanceof Error ? error.message : undefined,
      }),
  })
  if (query.isPending) return <RequestLoading />
  if (query.isError)
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  function submit(e: FormEvent) {
    e.preventDefault()
    if (displayName.trim()) mutation.mutate()
  }
  return (
    <form className='max-w-xl space-y-5' onSubmit={submit}>
      <div className='space-y-1'>
        <Label htmlFor='profile-email'>Organization email</Label>
        <Input id='profile-email' value={query.data.email} disabled />
        <p className='text-xs text-muted-foreground'>
          Managed by the organization; not editable here.
        </p>
      </div>
      <div className='space-y-1'>
        <Label htmlFor='profile-name'>Display name</Label>
        <Input
          id='profile-name'
          maxLength={200}
          required
          value={displayName}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className='space-y-1'>
        <Label htmlFor='profile-role'>System role</Label>
        <Input
          id='profile-role'
          value={query.data.globalRole.replace(/_/g, ' ')}
          disabled
        />
      </div>
      <Button
        disabled={
          mutation.isPending ||
          !displayName.trim() ||
          displayName.trim() === query.data.displayName
        }
      >
        Save profile
      </Button>
    </form>
  )
}
