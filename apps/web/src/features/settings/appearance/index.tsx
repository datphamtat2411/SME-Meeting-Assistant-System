import { useUiTranslation } from '@/lib/i18n'
import { ContentSection } from '../components/content-section'
import { AppearanceForm } from './appearance-form'

export function SettingsAppearance() {
  const { t } = useUiTranslation()
  return (
    <ContentSection
      title={t('settings:appearance')}
      desc={t('settings:appearanceDescription')}
    >
      <AppearanceForm />
    </ContentSection>
  )
}
