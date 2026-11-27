import { Languages } from 'lucide-react'
import { setUiLanguage, useUiTranslation } from '@/lib/i18n'
import { UI_LANGUAGES, isUiLanguage } from '@/lib/i18n/language-preference'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const names = { en: 'English', vi: 'Tiếng Việt' }

export function LanguageSwitcher() {
  const { t, i18n } = useUiTranslation()

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          aria-label={t('language')}
          className='h-8 shrink-0 gap-1 px-2'
        >
          <Languages className='size-4' aria-hidden='true' />
          {i18n.resolvedLanguage === 'vi' ? 'VI' : 'EN'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuRadioGroup
          value={i18n.resolvedLanguage}
          onValueChange={(language) => {
            if (isUiLanguage(language)) void setUiLanguage(language)
          }}
        >
          {UI_LANGUAGES.map((language) => (
            <DropdownMenuRadioItem key={language} value={language}>
              <span lang={language}>{names[language]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
