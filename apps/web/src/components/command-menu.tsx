import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Laptop, Moon, Sun } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { navigationGroups } from './layout/data/navigation-data'
import { ScrollArea } from './ui/scroll-area'

function searchKeywords(...labels: string[]) {
  return labels.flatMap((label) => [
    label,
    label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D'),
  ])
}

export function CommandMenu() {
  const { t } = useUiTranslation()
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return

    const frameId = window.requestAnimationFrame(() =>
      inputRef.current?.focus()
    )
    return () => window.cancelAnimationFrame(frameId)
  }, [open])

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  const label = (item: { title: string; titleKey?: string }) =>
    item.titleKey ? t(item.titleKey) : item.title

  return (
    <CommandDialog
      title={t('commandTitle')}
      description={t('commandDesc')}
      modal
      open={open}
      onOpenChange={setOpen}
    >
      <CommandInput ref={inputRef} placeholder={t('commandPlaceholder')} />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>{t('commandEmpty')}</CommandEmpty>
          {navigationGroups.map((group) => (
            <CommandGroup
              key={group.titleKey ?? group.title}
              heading={label(group)}
              value={group.titleKey ?? group.title}
            >
              {group.items.map((navItem) => {
                if (navItem.url)
                  return (
                    <CommandItem
                      key={navItem.url}
                      value={`${group.title} ${navItem.title} ${navItem.url}`}
                      keywords={searchKeywords(label(group), label(navItem))}
                      onSelect={() => {
                        runCommand(() => navigate({ to: navItem.url }))
                      }}
                    >
                      <div className='flex size-4 items-center justify-center'>
                        <ArrowRight className='size-2 text-muted-foreground/80' />
                      </div>
                      {label(navItem)}
                    </CommandItem>
                  )

                return navItem.items?.map((subItem) => (
                  <CommandItem
                    key={subItem.url}
                    value={`${group.title} ${navItem.title} ${subItem.title} ${subItem.url}`}
                    keywords={searchKeywords(
                      label(group),
                      label(navItem),
                      label(subItem)
                    )}
                    onSelect={() => {
                      runCommand(() => navigate({ to: subItem.url }))
                    }}
                  >
                    <div className='flex size-4 items-center justify-center'>
                      <ArrowRight className='size-2 text-muted-foreground/80' />
                    </div>
                    {label(navItem)} <ChevronRight aria-hidden='true' />{' '}
                    {label(subItem)}
                  </CommandItem>
                ))
              })}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup heading={t('navigation:appearance')}>
            <CommandItem
              value='Appearance Light theme'
              keywords={searchKeywords(t('navigation:appearance'), t('light'))}
              onSelect={() => runCommand(() => setTheme('light'))}
            >
              <Sun /> <span>{t('light')}</span>
            </CommandItem>
            <CommandItem
              value='Appearance Dark theme'
              keywords={searchKeywords(t('navigation:appearance'), t('dark'))}
              onSelect={() => runCommand(() => setTheme('dark'))}
            >
              <Moon className='scale-90' />
              <span>{t('dark')}</span>
            </CommandItem>
            <CommandItem
              value='Appearance System theme'
              keywords={searchKeywords(t('navigation:appearance'), t('system'))}
              onSelect={() => runCommand(() => setTheme('system'))}
            >
              <Laptop />
              <span>{t('system')}</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
