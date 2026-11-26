import { AuthLifecycleStaleResponseError } from '@/lib/core-api'
import {
  getRequestRecoveryGeneration,
  getSessionRevalidationGeneration,
  isRequestRecoveryBlocked,
  isSessionRevalidationRequired,
} from '@/lib/request-recovery'

export function settingsSessionGeneration() {
  return [
    getRequestRecoveryGeneration(),
    getSessionRevalidationGeneration(),
  ].join(':')
}

export function isSettingsSessionCurrent(generation: string) {
  return (
    generation === settingsSessionGeneration() &&
    !isRequestRecoveryBlocked() &&
    !isSessionRevalidationRequired()
  )
}

export function requireSettingsSession(generation: string) {
  if (!isSettingsSessionCurrent(generation)) {
    throw new AuthLifecycleStaleResponseError()
  }
}
