import { ContentSection } from '../components/content-section'
import { AccountForm } from './account-form'

export function SettingsAccount() {
  return (
    <ContentSection
      title='Account'
      desc='Manage your preferred time zone and regional formatting.'
    >
      <AccountForm />
    </ContentSection>
  )
}
