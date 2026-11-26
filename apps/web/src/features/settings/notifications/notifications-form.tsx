import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
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
import { Switch } from '@/components/ui/switch'
import { RequestError, RequestLoading } from '@/components/request-state'
import {
  preferencesMutationInput,
  preferencesQuery,
  preferencesQueryKey,
  usePreferencesMutation,
  type Preferences,
  type PreferencesPatch,
} from '../preferences-api'
import {
  isSettingsSessionCurrent,
  requireSettingsSession,
  settingsSessionGeneration,
} from '../settings-session'

const schema = z.object({
  meetingEmailEnabled: z.boolean(),
  actionItemEmailEnabled: z.boolean(),
})
type NotificationDraft = z.infer<typeof schema>

const fields = [
  {
    name: 'meetingEmailEnabled',
    label: 'Meeting emails',
    description:
      'Invitations, participant changes, rescheduling and cancellations.',
  },
  {
    name: 'actionItemEmailEnabled',
    label: 'Action item emails',
    description: 'Notifications when work is assigned or reassigned to you.',
  },
] as const

function notificationDraft(data: Preferences): NotificationDraft {
  return {
    meetingEmailEnabled: data.meetingEmailEnabled,
    actionItemEmailEnabled: data.actionItemEmailEnabled,
  }
}

export function NotificationsForm() {
  const query = useQuery(preferencesQuery())
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
      <NotificationEditor preferences={query.data} />
    </>
  )
}

function NotificationEditor({ preferences }: { preferences: Preferences }) {
  const qc = useQueryClient()
  const form = useForm<NotificationDraft>({
    resolver: zodResolver(schema),
    defaultValues: notificationDraft(preferences),
  })
  const {
    reset,
    getFieldState,
    getValues,
    setValue,
    setError,
    clearErrors,
    formState: { dirtyFields },
  } = form
  const [reconcile, setReconcile] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const mutation = usePreferencesMutation()
  const draft = useWatch({ control: form.control })
  const changed = fields.some(
    ({ name }) => dirtyFields[name] && draft[name] !== preferences[name]
  )
  const busy = mutation.isPending || refreshing

  const reconcileDraft = useCallback(
    (latest: NotificationDraft) => {
      const values = getValues()
      const pending = fields.filter(
        ({ name }) =>
          getFieldState(name).isDirty && values[name] !== latest[name]
      )
      reset(latest, { keepErrors: true })
      for (const { name } of pending) {
        setValue(name, values[name], { shouldDirty: true })
      }
    },
    [getFieldState, getValues, reset, setValue]
  )

  const { meetingEmailEnabled, actionItemEmailEnabled } = preferences
  useEffect(() => {
    reconcileDraft({ meetingEmailEnabled, actionItemEmailEnabled })
  }, [meetingEmailEnabled, actionItemEmailEnabled, reconcileDraft])

  async function refresh(discard: boolean) {
    const generation = settingsSessionGeneration()
    setRefreshing(true)
    try {
      requireSettingsSession(generation)
      await qc.cancelQueries({ queryKey: preferencesQueryKey })
      requireSettingsSession(generation)
      const latest = await qc.fetchQuery({
        ...preferencesQuery(),
        staleTime: 0,
      })
      requireSettingsSession(generation)
      if (discard) reset(notificationDraft(latest))
      else reconcileDraft(notificationDraft(latest))
      setReconcile(false)
      clearErrors()
    } catch (error) {
      if (isSettingsSessionCurrent(generation)) {
        setError('root', { message: normalizeCoreApiError(error).message })
      }
    } finally {
      setRefreshing(false)
    }
  }

  async function save(data: NotificationDraft) {
    if (busy || reconcile) return
    const patch: PreferencesPatch = {}
    for (const { name } of fields) {
      if (dirtyFields[name] && data[name] !== preferences[name]) {
        patch[name] = data[name]
      }
    }
    if (!Object.keys(patch).length) return
    clearErrors()
    const input = preferencesMutationInput(patch)
    try {
      const confirmed = await mutation.mutateAsync(input)
      if (!isSettingsSessionCurrent(input.generation)) return
      const latest =
        qc.getQueryData<Preferences>(preferencesQueryKey) ?? confirmed
      reset(notificationDraft(latest))
      toast.success('Notification preferences saved')
    } catch (error) {
      if (!isSettingsSessionCurrent(input.generation)) return
      const failure = normalizeCoreApiError(error)
      for (const { name } of fields) {
        const message = failure.fieldErrors[name]?.join(' ')
        if (message) setError(name, { message })
      }
      const uncertain =
        failure.kind === 'network' ||
        failure.kind === 'malformed' ||
        failure.isServerError
      setReconcile(uncertain)
      setError('root', {
        message: uncertain
          ? 'The save outcome is uncertain. Refresh saved preferences before retrying.'
          : failure.message,
      })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(save)} className='max-w-xl space-y-6'>
        <h3 className='font-medium'>Optional email notifications</h3>
        {fields.map(({ name, label, description }) => (
          <FormField
            key={name}
            control={form.control}
            name={name}
            render={({ field }) => (
              <FormItem className='flex items-start justify-between gap-4 rounded-lg border p-4'>
                <div className='space-y-1'>
                  <FormLabel>{label}</FormLabel>
                  <FormDescription>{description}</FormDescription>
                  <FormMessage />
                </div>
                <FormControl>
                  <Switch
                    type='button'
                    name={field.name}
                    ref={field.ref}
                    checked={field.value}
                    onBlur={field.onBlur}
                    onCheckedChange={field.onChange}
                    disabled={busy}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        ))}
        <p className='text-sm text-muted-foreground'>
          Turning off optional emails does not affect your meeting participation
          or assigned work. Preferences control email eligibility and do not
          guarantee delivery.
        </p>
        <section className='space-y-3 border-t pt-6'>
          <h3 className='font-medium'>Required communications</h3>
          <div className='space-y-1 rounded-lg border bg-muted/30 p-4'>
            <p className='text-sm font-medium'>Account and security emails</p>
            <p className='text-sm text-muted-foreground'>
              Essential account and security communications cannot be disabled.
            </p>
          </div>
        </section>
        {form.formState.errors.root?.message && (
          <p role='alert' className='text-sm text-destructive'>
            {form.formState.errors.root.message}
          </p>
        )}
        {reconcile && (
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() => void refresh(false)}
          >
            Refresh saved preferences
          </Button>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button type='submit' disabled={!changed || busy || reconcile}>
            {mutation.isPending ? 'Saving…' : 'Save notifications'}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={busy || (!changed && !reconcile)}
            onClick={() => {
              if (reconcile) void refresh(true)
              else reset(notificationDraft(preferences))
            }}
          >
            Discard
          </Button>
        </div>
      </form>
    </Form>
  )
}
