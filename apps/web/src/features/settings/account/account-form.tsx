import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
} from '@/lib/i18n/presentation'
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
  const { t, i18n } = useUiTranslation()
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
  const uiLanguage = i18n.resolvedLanguage ?? 'en'
  const formatLocaleLabel = useCallback(
    (value: string) => localeLabel(value, uiLanguage),
    [uiLanguage]
  )
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
          message: featureValidationMessage('settings:invalidTimezone'),
        })
        return
      }
      patch.timezone = data.timezone
    }
    if (dirtyFields.locale && data.locale !== preferences.locale) {
      if (data.locale !== null && !isLocaleTag(data.locale)) {
        setError('locale', { message: featureValidationMessage('settings:invalidLocale') })
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
      toast.success(t('settings:accountSaved'))
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
          ? featureValidationMessage('settings:saveUncertain')
          : failure.message,
      })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(save)} className='max-w-xl space-y-6'>
        <h3 className='font-medium'>{t('settings:regionalPreferences')}</h3>
        <FormField
          control={form.control}
          name='timezone'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('settings:timezone')}</FormLabel>
              <RegionalPicker
                label={t('settings:timezone')}
                value={field.value}
                onChange={field.onChange}
                options={zones}
                formatLabel={timezoneLabel}
                validateCustom={isTimezoneSelection}
                disabled={busy}
              />
              <FormDescription>
                {t('settings:timezoneDescription')}
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
              <FormLabel>{t('settings:regionalFormat')}</FormLabel>
              <RegionalPicker
                label={t('settings:regionalFormat')}
                value={field.value}
                onChange={field.onChange}
                options={localeOptions}
                formatLabel={formatLocaleLabel}
                validateCustom={isLocaleTag}
                disabled={busy}
              />
              <FormDescription>
                {t('settings:regionalDescription')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <section className='space-y-3 rounded-lg border bg-muted/30 p-4'>
          <h3 className='text-sm font-medium'>{t('settings:formatPreview')}</h3>
          <dl className='grid grid-cols-[auto_1fr] gap-2 text-sm'>
            <dt className='text-muted-foreground'>{t('settings:date')}</dt>
            <dd>
              {new Intl.DateTimeFormat(preview.locale, {
                dateStyle: 'long',
                calendar: 'gregory',
                timeZone: preview.timezone,
              }).format(reference)}
            </dd>
            <dt className='text-muted-foreground'>{t('settings:time')}</dt>
            <dd>
              {new Intl.DateTimeFormat(preview.locale, {
                timeStyle: 'short',
                timeZone: preview.timezone,
              }).format(reference)}
            </dd>
            <dt className='text-muted-foreground'>{t('settings:number')}</dt>
            <dd>
              {new Intl.NumberFormat(preview.locale, {
                minimumFractionDigits: 2,
              }).format(12500.5)}
            </dd>
          </dl>
          {(preview.timezoneFallback || preview.localeFallback) && (
            <p role='status' className='text-sm text-muted-foreground'>
              {t('settings:regionalFallback', {
                timezone: preview.timezone,
                locale: preview.locale,
              })}
            </p>
          )}
        </section>
        <p className='text-sm text-muted-foreground'>
          {t('settings:savedRegional', {
            timezone: preferences.timezone ?? t('settings:browserDefault'),
            locale: preferences.locale ?? t('settings:browserDefault'),
          })}
        </p>
        {form.formState.errors.root?.message && (
          <p role='alert' className='text-sm text-destructive'>
            {localizedValidationMessage(form.formState.errors.root.message, t)}
          </p>
        )}
        {reconcile && (
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() => void refresh(false)}
          >
            {t('settings:refreshPreferences')}
          </Button>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button type='submit' disabled={!changed || busy || reconcile}>
            {mutation.isPending ? t('settings:saving') : t('settings:savePreferences')}
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
            {t('settings:discard')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
