import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { resetRequestRecoveryState } from '@/lib/request-recovery'
import {
  beginAssistantQuestion,
  captureAssistantAccess,
  containAssistantAccessFailure,
  isAssistantAccessCurrent,
  readAssistantProtected,
  retryAssistantAccess,
} from './assistant-access'

describe('Assistant protected operation ownership', () => {
  it('clears a denied resource and fences a previously started read and mutation', async () => {
    const client = new QueryClient()
    client.setQueryData(['assistant', 'conversation', 'a', 'history'], {
      content: 'protected',
    })
    client.setQueryData(['assistant', 'turn', 'a', 'latest-accepted'], {
      content: 'protected',
    })
    const operation = beginAssistantQuestion(client, 'a')
    let complete!: (value: string) => void
    const delayed = readAssistantProtected(
      client,
      'a',
      () => new Promise<string>((resolve) => { complete = resolve })
    )
    const denied = new CoreApiError({
      status: 403,
      kind: 'http',
      message: 'Denied',
    })
    expect(containAssistantAccessFailure(
      client,
      captureAssistantAccess(client, 'a'),
      denied
    )).toBe(true)
    expect(client.getQueryData(['assistant', 'conversation', 'a', 'history'])).toBeUndefined()
    expect(client.getQueryData(['assistant', 'turn', 'a', 'latest-accepted'])).toBeUndefined()
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
    retryAssistantAccess(client, 'a')
    complete('old protected response')
    await expect(delayed).rejects.toMatchObject({ code: 'ASSISTANT_OPERATION_OBSOLETE' })
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
  })

  it('rejects a delayed result after the existing session generation changes', async () => {
    const client = new QueryClient()
    const operation = captureAssistantAccess(client, 'a')
    let complete!: (value: string) => void
    const pending = readAssistantProtected(
      client,
      'a',
      () => new Promise<string>((resolve) => { complete = resolve })
    )
    resetRequestRecoveryState()
    complete('previous session')
    await expect(pending).rejects.toMatchObject({ code: 'ASSISTANT_OPERATION_OBSOLETE' })
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
  })

  it('does not let an earlier question overwrite a newer operation', () => {
    const client = new QueryClient()
    const earlier = beginAssistantQuestion(client, 'a')
    const newer = beginAssistantQuestion(client, 'a')
    expect(isAssistantAccessCurrent(client, earlier)).toBe(false)
    expect(isAssistantAccessCurrent(client, newer)).toBe(true)
  })
})
