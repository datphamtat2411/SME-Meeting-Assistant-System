import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequestError, RequestLoading } from '@/components/request-state'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import {
  isSettingsSessionCurrent,
  requireSettingsSession,
  settingsSessionGeneration,
} from '../settings-session'
import {
  displayNameSchema,
  myProfileQuery,
  profileQueryKey,
  updateMyProfile,
  type ProfileSnapshot,
} from './profile-api'

const schema = z.object({
  displayName: displayNameSchema,
  etag: z.string(),
})
type ProfileDraft = z.infer<typeof schema>

function draftOf(snapshot: ProfileSnapshot): ProfileDraft {
  return {
    displayName: snapshot.profile.displayName,
    etag: snapshot.etag,
  }
}

const roleLabels = {
  EMPLOYEE: 'Employee',
  DEPARTMENT_MANAGER: 'Department manager',
  ADMINISTRATOR: 'Administrator',
}

const statusLabels = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  PENDING_SETUP: 'Pending setup',
}

export function ProfileForm() {
  const query = useQuery(myProfileQuery())
  if (!query.data) {
    if (query.isPending) return <RequestLoading />
    return (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    )
  }
  return (
    <>
      {query.isError && (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      )}
      <ProfileEditor key={query.data.profile.id} snapshot={query.data} />
    </>
  )
}

function ProfileEditor({ snapshot }: { snapshot: ProfileSnapshot }) {
  const qc = useQueryClient()
  const form = useForm<ProfileDraft>({
    resolver: zodResolver(schema),
    defaultValues: draftOf(snapshot),
    mode: 'onChange',
  })
  const {
    reset,
    setValue,
    setError,
    clearErrors,
    formState: { isDirty, isValid },
  } = form
  const name = useWatch({ control: form.control, name: 'displayName' })
  const etag = useWatch({ control: form.control, name: 'etag' })
  const [recovery, setRecovery] = useState<'refresh' | 'review' | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const conflict = isDirty && etag !== snapshot.etag

  useEffect(() => {
    if (!isDirty) reset(draftOf(snapshot))
  }, [isDirty, reset, snapshot])

  async function reviewLatest(generation: string) {
    setRefreshing(true)
    try {
      requireSettingsSession(generation)
      await qc.cancelQueries({ queryKey: profileQueryKey })
      const latest = await qc.fetchQuery({ ...myProfileQuery(), staleTime: 0 })
      requireSettingsSession(generation)
      setRecovery('review')
      return latest
    } catch (error) {
      if (isSettingsSessionCurrent(generation)) {
        setRecovery('refresh')
        setError('root', { message: normalizeCoreApiError(error).message })
      }
      return undefined
    } finally {
      setRefreshing(false)
    }
  }

  const mutation = useMutation({
    retry: false,
    mutationFn: async ({
      draft,
      generation,
      id,
    }: {
      draft: ProfileDraft
      generation: string
      id: string
    }) => {
      requireSettingsSession(generation)
      await qc.cancelQueries({ queryKey: profileQueryKey })
      requireSettingsSession(generation)
      return updateMyProfile(draft.displayName, { id, etag: draft.etag })
    },
    onSuccess: async (updated, { generation }) => {
      if (!isSettingsSessionCurrent(generation)) return
      await qc.cancelQueries({ queryKey: profileQueryKey })
      if (!isSettingsSessionCurrent(generation)) return
      qc.setQueryData(profileQueryKey, updated)
      reset(draftOf(updated))
      setRecovery(null)
      toast.success('Profile updated')
      await qc.invalidateQueries({ queryKey: currentUserQueryKey })
    },
    onError: async (error, { generation }) => {
      if (!isSettingsSessionCurrent(generation)) return
      const failure = normalizeCoreApiError(error)
      const fieldError = failure.fieldErrors.displayName?.join(' ')
      if (fieldError) setError('displayName', { message: fieldError })
      if (
        failure.status === 412 ||
        failure.status === 428 ||
        failure.kind === 'network' ||
        failure.kind === 'malformed' ||
        failure.isServerError
      ) {
        setRecovery('refresh')
        setError('root', {
          message:
            failure.status === 412 || failure.status === 428
              ? 'The profile version needs to be reviewed before saving.'
              : 'The save outcome could not be confirmed. Review the server value before retrying.',
        })
        await reviewLatest(generation)
      } else {
        setError('root', { message: failure.message })
      }
    },
  })

  const busy = mutation.isPending || refreshing
  const profile = snapshot.profile
  const initials = profile.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase()

  function acceptLatest(keepDraft: boolean) {
    // Accept the exact snapshot displayed to the user, never an unseen
    // replacement fetched after the user has made their decision.
    const retained = form.getValues('displayName')
    reset(draftOf(snapshot))
    if (keepDraft && retained !== snapshot.profile.displayName) {
      setValue('displayName', retained, {
        shouldDirty: true,
        shouldValidate: true,
      })
    }
    setRecovery(null)
  }

  return (
    <Form {...form}>
      <form
        className='max-w-xl space-y-6'
        onSubmit={form.handleSubmit((draft) => {
          if (
            busy ||
            recovery ||
            conflict ||
            draft.displayName === profile.displayName
          )
            return
          clearErrors()
          mutation.mutate({
            draft,
            id: profile.id,
            generation: settingsSessionGeneration(),
          })
        })}
      >
        <div className='flex items-center gap-4 rounded-lg border p-4'>
          <Avatar className='size-14'>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className='min-w-0'>
            <p className='font-semibold break-words'>{profile.displayName}</p>
            <p className='text-sm break-all text-muted-foreground'>
              {profile.email}
            </p>
            <p className='text-sm text-muted-foreground'>
              {roleLabels[profile.globalRole]} ·{' '}
              {statusLabels[profile.accountStatus]}
            </p>
          </div>
        </div>
        <FormField
          control={form.control}
          name='displayName'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display name</FormLabel>
              <FormControl>
                <Input {...field} maxLength={200} disabled={busy} />
              </FormControl>
              <FormDescription>
                Your name as shown in meetings and the member directory.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <section className='space-y-4'>
          <h3 className='text-sm font-medium'>
            Organization-managed information
          </h3>
          {[
            ['profile-email', 'Organization email', profile.email],
            ['profile-role', 'System role', roleLabels[profile.globalRole]],
            [
              'profile-status',
              'Account status',
              statusLabels[profile.accountStatus],
            ],
          ].map(([id, label, value]) => (
            <div key={id} className='space-y-2'>
              <Label htmlFor={id}>{label}</Label>
              <Input id={id} value={value} readOnly />
            </div>
          ))}
          <p className='text-sm text-muted-foreground'>
            These values are managed by your organization and cannot be edited
            here.
          </p>
        </section>
        {form.formState.errors.root?.message && (
          <p role='alert' className='text-sm text-destructive'>
            {form.formState.errors.root.message}
          </p>
        )}
        {(conflict || recovery) && (
          <section className='space-y-3 rounded-lg border p-4'>
            <h3 className='font-medium'>Review the latest profile</h3>
            <p className='text-sm'>
              Latest retrieved name: {profile.displayName}
            </p>
            <p className='text-sm'>Your draft: {name}</p>
            <p className='text-sm text-muted-foreground'>
              Refresh and review the saved value before another update.
            </p>
            {recovery === 'refresh' ? (
              <Button
                type='button'
                variant='outline'
                disabled={busy}
                onClick={() => void reviewLatest(settingsSessionGeneration())}
              >
                Refresh latest profile
              </Button>
            ) : (
              <Button
                type='button'
                variant='outline'
                disabled={busy}
                onClick={() => acceptLatest(true)}
              >
                Keep my draft against this version
              </Button>
            )}
          </section>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button
            type='submit'
            disabled={
              busy ||
              recovery !== null ||
              conflict ||
              !isDirty ||
              !isValid ||
              name.trim() === profile.displayName
            }
          >
            {mutation.isPending ? 'Saving…' : 'Save profile'}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={busy || recovery === 'refresh' || (!isDirty && !recovery)}
            onClick={() => {
              if (recovery || conflict) acceptLatest(false)
              else reset(draftOf(snapshot))
            }}
          >
            Discard
          </Button>
        </div>
      </form>
    </Form>
  )
}
