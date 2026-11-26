import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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
  isLocaleTag,
  isTimezoneSelection,
  localeLabel,
  localeOptions,
  resolveRegionalPreferences,
  timezoneLabel,
  timezoneOptions,
} from '../regional-preferences'
import {
  isSettingsSessionCurrent,
  requireSettingsSession,
  settingsSessionGeneration,
} from '../settings-session'
import { RegionalPicker } from './regional-picker'

const schema = z.object({
  timezone: z.string().nullable(),
  locale: z.string().nullable(),
})
type RegionalDraft = z.infer<typeof schema>

function regionalDraft(data: Preferences): RegionalDraft {
  return { timezone: data.timezone, locale: data.locale }
}

export function AccountForm() {
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
      <AccountEditor preferences={query.data} />
    </>
  )
}

function AccountEditor({ preferences }: { preferences: Preferences }) {
  const qc = useQueryClient()
  const form = useForm<RegionalDraft>({
    resolver: zodResolver(schema),
    defaultValues: regionalDraft(preferences),
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
  const timezone = useWatch({ control: form.control, name: 'timezone' })
  const locale = useWatch({ control: form.control, name: 'locale' })
  const zones = useMemo(() => timezoneOptions(), [])
  const preview = resolveRegionalPreferences({ timezone, locale })
  const reference = new Date('2026-01-15T09:30:00Z')
  const changed =
    (dirtyFields.timezone && timezone !== preferences.timezone) ||
    (dirtyFields.locale && locale !== preferences.locale)
  const busy = mutation.isPending || refreshing

  const reconcileDraft = useCallback(
    (latest: RegionalDraft) => {
      const draft = getValues()
      const keepTimezone =
        getFieldState('timezone').isDirty && draft.timezone !== latest.timezone
      const keepLocale =
        getFieldState('locale').isDirty && draft.locale !== latest.locale

      // Rebase on confirmed values, then restore only edits that still differ.
      // A converged draft must stop being dirty before another server update.
      reset(latest)
      if (keepTimezone) {
        setValue('timezone', draft.timezone, { shouldDirty: true })
      }
      if (keepLocale) {
        setValue('locale', draft.locale, { shouldDirty: true })
      }
    },
    [getFieldState, getValues, reset, setValue]
  )

  const { timezone: savedTimezone, locale: savedLocale } = preferences
  useEffect(() => {
    reconcileDraft({ timezone: savedTimezone, locale: savedLocale })
  }, [savedTimezone, savedLocale, reconcileDraft])

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
      if (discard) reset(regionalDraft(latest))
      else reconcileDraft(regionalDraft(latest))
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

  async function save(data: RegionalDraft) {
    if (busy || reconcile) return
    const patch: PreferencesPatch = {}
    if (dirtyFields.timezone && data.timezone !== preferences.timezone) {
      if (data.timezone !== null && !isTimezoneSelection(data.timezone)) {
        setError('timezone', {
          message: 'Select a valid IANA timezone identifier.',
        })
        return
      }
      patch.timezone = data.timezone
    }
    if (dirtyFields.locale && data.locale !== preferences.locale) {
      if (data.locale !== null && !isLocaleTag(data.locale)) {
        setError('locale', { message: 'Enter a valid regional locale.' })
        return
      }
      patch.locale = data.locale
    }
    if (!Object.keys(patch).length) return
    clearErrors()
    const input = preferencesMutationInput(patch)
    try {
      const confirmed = await mutation.mutateAsync(input)
      if (!isSettingsSessionCurrent(input.generation)) return
      const latest =
        qc.getQueryData<Preferences>(preferencesQueryKey) ?? confirmed
      reset(regionalDraft(latest))
      toast.success('Account preferences saved')
    } catch (error) {
      if (!isSettingsSessionCurrent(input.generation)) return
      const failure = normalizeCoreApiError(error)
      for (const field of ['timezone', 'locale'] as const) {
        const message = failure.fieldErrors[field]?.join(' ')
        if (message) setError(field, { message })
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
        <h3 className='font-medium'>Regional preferences</h3>
        <FormField
          control={form.control}
          name='timezone'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Time zone</FormLabel>
              <RegionalPicker
                label='Time zone'
                value={field.value}
                onChange={field.onChange}
                options={zones}
                formatLabel={timezoneLabel}
                validateCustom={isTimezoneSelection}
                disabled={busy}
              />
              <FormDescription>
                Choose a preferred time zone or use your browser default. The
                server validates time zone identifiers.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='locale'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Regional format</FormLabel>
              <RegionalPicker
                label='Regional format'
                value={field.value}
                onChange={field.onChange}
                options={localeOptions}
                formatLabel={localeLabel}
                validateCustom={isLocaleTag}
                disabled={busy}
              />
              <FormDescription>
                Choose date, time and number formats, not the interface
                language.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <section className='space-y-3 rounded-lg border bg-muted/30 p-4'>
          <h3 className='text-sm font-medium'>Format preview</h3>
          <dl className='grid grid-cols-[auto_1fr] gap-2 text-sm'>
            <dt className='text-muted-foreground'>Date</dt>
            <dd>
              {new Intl.DateTimeFormat(preview.locale, {
                dateStyle: 'long',
                timeZone: preview.timezone,
              }).format(reference)}
            </dd>
            <dt className='text-muted-foreground'>Time</dt>
            <dd>
              {new Intl.DateTimeFormat(preview.locale, {
                timeStyle: 'short',
                timeZone: preview.timezone,
              }).format(reference)}
            </dd>
            <dt className='text-muted-foreground'>Number</dt>
            <dd>
              {new Intl.NumberFormat(preview.locale, {
                minimumFractionDigits: 2,
              }).format(12500.5)}
            </dd>
          </dl>
          {(preview.timezoneFallback || preview.localeFallback) && (
            <p role='status' className='text-sm text-muted-foreground'>
              Your browser cannot use one of the selected values. The preview
              uses {preview.timezone} and {preview.locale} without changing
              saved preferences.
            </p>
          )}
        </section>
        <p className='text-sm text-muted-foreground'>
          Saved time zone: {preferences.timezone ?? 'Browser default'}. Saved
          regional format: {preferences.locale ?? 'Browser default'}. These
          settings are used in this preview; schedule integration is not yet
          available.
        </p>
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
            {mutation.isPending ? 'Saving…' : 'Save preferences'}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={busy || (!changed && !reconcile)}
            onClick={() => {
              if (reconcile) void refresh(true)
              else reset(regionalDraft(preferences))
            }}
          >
            Discard
          </Button>
        </div>
      </form>
    </Form>
  )
}
