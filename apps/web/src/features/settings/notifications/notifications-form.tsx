import { SettingsUnavailable } from '../components/settings-unavailable'

export function NotificationsForm() {
  return (
    <SettingsUnavailable
      title='Notification preferences are unavailable'
      description='Notification delivery preferences are not connected to this workspace yet.'
    />
  )
}
