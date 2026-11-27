import { useUiTranslation } from '@/lib/i18n'
import { ContentSection } from '../components/content-section'
import { AccountForm } from './account-form'

export function SettingsAccount() {
  const { t } = useUiTranslation()
  return (
    <ContentSection
      title={t('settings:account')}
      desc={t('settings:accountDescription')}
    >
      <AccountForm />
    </ContentSection>
  )
}
