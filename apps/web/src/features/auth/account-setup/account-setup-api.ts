import { coreApi } from '@/lib/core-api'

export interface AccountSetupCredentials {
  token: string
  password: string
}

export async function completeAccountSetup(
  credentials: AccountSetupCredentials
): Promise<void> {
  await coreApi.post<null>('/auth/account-setup', credentials)
}
