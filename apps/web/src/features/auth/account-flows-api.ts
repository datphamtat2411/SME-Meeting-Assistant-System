import { CoreApiError, coreApi } from '@/lib/core-api'

const requestOptions = { timeout: 30_000 }

interface NeutralAcknowledgement {
  message: string
}

interface CredentialRequest {
  token: string
  password: string
}

function malformedResponse(): never {
  throw new CoreApiError({
    kind: 'malformed',
    code: 'MALFORMED_RESPONSE',
    message: 'Unexpected account-flow response.',
  })
}

function verifyAcknowledgement(data: unknown): void {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('message' in data) ||
    typeof data.message !== 'string' ||
    data.message.trim() === ''
  ) {
    malformedResponse()
  }
}

export async function requestPasswordRecovery(email: string): Promise<void> {
  const data = await coreApi.post<NeutralAcknowledgement>(
    '/auth/password-recovery',
    { email: email.trim() },
    requestOptions
  )
  verifyAcknowledgement(data)
}

export async function completeAccountSetup(
  token: string,
  password: string
): Promise<void> {
  const payload: CredentialRequest = { token, password }
  const data = await coreApi.post<null>(
    '/auth/account-setup',
    payload,
    requestOptions
  )
  if (data !== null) malformedResponse()
}

export async function resetAccountPassword(
  token: string,
  password: string
): Promise<void> {
  const payload: CredentialRequest = { token, password }
  const data = await coreApi.post<NeutralAcknowledgement>(
    '/auth/password-reset',
    payload,
    requestOptions
  )
  verifyAcknowledgement(data)
}
