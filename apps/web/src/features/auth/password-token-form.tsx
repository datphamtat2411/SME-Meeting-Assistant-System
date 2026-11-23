import { useEffect, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import {
  completeAccountSetup,
  resetAccountPassword,
  validNewPassword,
} from './account-flows-api'

export function PasswordTokenForm({ kind }: { kind: 'setup' | 'reset' }) {
  const [token, setToken] = useState(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const value = fragment.get('token')
    return value && value.length <= 4096 ? value : ''
  })
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [submitError, setSubmitError] = useState('')
  useEffect(() => {
    // Immediately remove single-use bearer capability from the browser address bar/history.
    if (window.location.hash)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      )
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!validNewPassword(password)) {
      toast.error('Use 15–128 Unicode characters for your password.')
      return
    }
    if (password !== confirmation) {
      toast.error('Passwords do not match.')
      return
    }
    if (!token) {
      toast.error('The account link is missing or expired.')
      return
    }
    setBusy(true)
    setSubmitError('')
    try {
      if (kind === 'setup') await completeAccountSetup(token, password)
      else await resetAccountPassword(token, password)
      setToken('')
      setPassword('')
      setConfirmation('')
      setComplete(true)
      toast.success(
        kind === 'setup' ? 'Account setup complete' : 'Password reset complete'
      )
    } catch (error) {
      const failure = normalizeCoreApiError(error)
      const message =
        failure.status === 404
          ? 'This account flow is unavailable on the current server.'
          : failure.status === 422
            ? 'The link may have expired or the password did not meet organization policy. Review the password and request a new link if necessary.'
            : failure.status === 429
              ? 'Too many attempts. Try again later.'
              : 'Unable to complete account verification. Try again.'
      setSubmitError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }
  if (complete)
    return (
      <div className='space-y-4'>
        <p role='status' className='text-sm'>
          Your password was set successfully. You can sign in with your
          organizational email.
        </p>
        <Button asChild>
          <Link to='/sign-in'>Sign in</Link>
        </Button>
      </div>
    )
  if (!token)
    return (
      <div className='space-y-3'>
        <p role='alert' className='text-sm text-destructive'>
          This page requires a valid single-use authorization link from your
          organization. Request a new email if it expired.
        </p>
        <Button asChild variant='outline'>
          <Link to={kind === 'reset' ? '/forgot-password' : '/sign-in'}>
            {kind === 'reset' ? 'Request recovery' : 'Back to sign in'}
          </Link>
        </Button>
      </div>
    )
  return (
    <form className='space-y-4' onSubmit={submit}>
      <div className='space-y-1'>
        <Label htmlFor='new-password'>New password</Label>
        <PasswordInput
          id='new-password'
          autoComplete='new-password'
          minLength={15}
          maxLength={128}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className='text-xs text-muted-foreground'>
          15–128 characters. Unicode and spaces are supported; do not reuse a
          compromised password.
        </p>
      </div>
      <div className='space-y-1'>
        <Label htmlFor='confirm-password'>Confirm password</Label>
        <PasswordInput
          id='confirm-password'
          autoComplete='new-password'
          minLength={15}
          maxLength={128}
          required
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </div>
      {submitError && (
        <p role='alert' className='text-sm text-destructive'>
          {submitError}
        </p>
      )}
      <Button
        disabled={
          busy || !validNewPassword(password) || password !== confirmation
        }
      >
        {busy
          ? 'Submitting…'
          : kind === 'setup'
            ? 'Activate account'
            : 'Reset password'}
      </Button>
    </form>
  )
}
