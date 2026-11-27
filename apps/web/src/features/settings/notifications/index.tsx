import { useUiTranslation } from '@/lib/i18n'
import { ContentSection } from '../components/content-section'
import { NotificationsForm } from './notifications-form'

export function SettingsNotifications() {
  const { t } = useUiTranslation()
  return (
    <ContentSection
      title={t('settings:notifications')}
      desc={t('settings:notificationDescription')}
    >
      <NotificationsForm />
    </ContentSection>
  )
}
