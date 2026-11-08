import { SettingsUnavailable } from '../components/settings-unavailable'

export function ProfileForm() {
  return (
    <SettingsUnavailable
      title='Profile editing is unavailable'
      description='Profile details are not connected to this workspace yet.'
    />
  )
}
