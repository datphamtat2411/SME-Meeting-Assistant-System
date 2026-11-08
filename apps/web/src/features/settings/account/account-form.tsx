import { SettingsUnavailable } from '../components/settings-unavailable'

export function AccountForm() {
  return (
    <SettingsUnavailable
      title='Account settings are unavailable'
      description='Account and language changes are not connected to this workspace yet.'
    />
  )
}
