import { ContentSection } from '../components/content-section'
import { NotificationsForm } from './notifications-form'

export function SettingsNotifications() {
  return (
    <ContentSection
      title='Notifications'
      desc='Manage optional meeting and action item email communications.'
    >
      <NotificationsForm />
    </ContentSection>
  )
}
