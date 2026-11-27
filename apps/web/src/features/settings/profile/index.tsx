import { useUiTranslation } from '@/lib/i18n'
import { ContentSection } from '../components/content-section'
import { ProfileForm } from './profile-form'

export function SettingsProfile() {
  const { t } = useUiTranslation()
  return (
    <ContentSection
      title={t('settings:profile')}
      desc={t('settings:profileDescription')}
    >
      <ProfileForm />
    </ContentSection>
  )
}
