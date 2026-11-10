import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RequestError, RequestLoading } from '@/components/request-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { patchPreferences, preferencesQuery } from '../preferences-api'

export function AccountForm() {
  const qc = useQueryClient()
  const query = useQuery(preferencesQuery())
  const [timezone, setTimezone] = useState<string | null>(null)
  const [locale, setLocale] = useState<string | null>(null)
  const effectiveTimezone = timezone ?? query.data?.timezone ?? ''
  const effectiveLocale = locale ?? query.data?.locale ?? ''
  const mutation = useMutation({
    mutationFn: () => patchPreferences({ timezone: effectiveTimezone.trim() || null, locale: effectiveLocale.trim() || null }),
    onSuccess: data => { qc.setQueryData(['me', 'preferences'], data); toast.success('Account preferences saved') },
    onError: error => toast.error('Cannot save account preferences', { description: error instanceof Error ? error.message : undefined }),
  })
  if (query.isPending) return <RequestLoading />
  if (query.isError) return <RequestError error={query.error} retry={() => void query.refetch()} />
  function submit(e: FormEvent) { e.preventDefault(); mutation.mutate() }
  return <form onSubmit={submit} className='max-w-xl space-y-5'>
    <p className='text-sm text-muted-foreground'>Leave either preference empty to use your organization's default.</p>
    <div className='space-y-1'><Label htmlFor='account-timezone'>IANA timezone</Label><Input id='account-timezone' maxLength={64} placeholder='Asia/Ho_Chi_Minh' value={effectiveTimezone} onChange={e => setTimezone(e.target.value)} /><p className='text-xs text-muted-foreground'>Example: Asia/Ho_Chi_Minh or Europe/London.</p></div>
    <div className='space-y-1'><Label htmlFor='account-locale'>Language / locale</Label><Input id='account-locale' placeholder='vi-VN' value={effectiveLocale} onChange={e => setLocale(e.target.value)} /></div>
    <Button type='submit' disabled={mutation.isPending}>Save preferences</Button>
  </form>
}
