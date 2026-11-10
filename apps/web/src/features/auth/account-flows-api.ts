import { coreApi } from '@/lib/core-api'

export async function requestPasswordRecovery(email: string) {
  // Always show neutral acknowledgement: user/account existence is private.
  await coreApi.post('/auth/password-recovery', { email: email.trim() })
}
export async function resetAccountPassword(token: string, password: string) {
  await coreApi.post('/auth/password-reset', { token, password })
}
export async function completeAccountSetup(token: string, password: string) {
  await coreApi.post('/auth/account-setup', { token, password })
}
export function validNewPassword(value: string) {
  return Array.from(value).length >= 15 && Array.from(value).length <= 128
}
