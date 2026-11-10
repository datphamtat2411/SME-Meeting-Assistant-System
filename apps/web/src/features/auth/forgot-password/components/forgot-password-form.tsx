import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { requestPasswordRecovery } from '../../account-flows-api'

export function ForgotPasswordForm({ className, ...props }: React.ComponentProps<'form'>) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try { await requestPasswordRecovery(email); setSubmitted(true) }
    catch (error) { toast.error('Request could not be sent', { description: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }
  if (submitted) return <p role='status' className='rounded-lg border p-4 text-sm'>If an eligible account exists for that email, password reset instructions will be sent. Check your inbox.</p>
  return <form onSubmit={submit} className={cn('space-y-4', className)} {...props}><div className='space-y-1'><Label htmlFor='recover-email'>Organization email</Label><Input id='recover-email' type='email' required autoComplete='email' value={email} onChange={e => setEmail(e.target.value)} placeholder='name@company.com' /></div><Button disabled={busy || !email.trim()}>{busy ? 'Requesting…' : 'Send recovery link'}</Button></form>
}
