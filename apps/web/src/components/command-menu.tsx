import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Laptop, Moon, Sun } from 'lucide-react'
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

export function CommandMenu() {
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

  return (
    <CommandDialog
      title='Command menu'
      description='Navigate to a page or choose an appearance command.'
      modal
      open={open}
      onOpenChange={setOpen}
    >
      <CommandInput
        ref={inputRef}
        placeholder='Navigate to a page or command'
      />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>No matching pages or appearance commands.</CommandEmpty>
          {navigationGroups.map((group) => (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((navItem) => {
                if (navItem.url)
                  return (
                    <CommandItem
                      key={navItem.url}
                      value={`${group.title} ${navItem.title} ${navItem.url}`}
                      onSelect={() => {
                        runCommand(() => navigate({ to: navItem.url }))
                      }}
                    >
                      <div className='flex size-4 items-center justify-center'>
                        <ArrowRight className='size-2 text-muted-foreground/80' />
                      </div>
                      {navItem.title}
                    </CommandItem>
                  )

                return navItem.items?.map((subItem) => (
                  <CommandItem
                    key={`${navItem.title}-${subItem.url}`}
                    value={`${group.title} ${navItem.title} ${subItem.title} ${subItem.url}`}
                    onSelect={() => {
                      runCommand(() => navigate({ to: subItem.url }))
                    }}
                  >
                    <div className='flex size-4 items-center justify-center'>
                      <ArrowRight className='size-2 text-muted-foreground/80' />
                    </div>
                    {navItem.title} <ChevronRight aria-hidden='true' />{' '}
                    {subItem.title}
                  </CommandItem>
                ))
              })}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup heading='Appearance'>
            <CommandItem
              value='Appearance Light theme'
              onSelect={() => runCommand(() => setTheme('light'))}
            >
              <Sun /> <span>Light</span>
            </CommandItem>
            <CommandItem
              value='Appearance Dark theme'
              onSelect={() => runCommand(() => setTheme('dark'))}
            >
              <Moon className='scale-90' />
              <span>Dark</span>
            </CommandItem>
            <CommandItem
              value='Appearance System theme'
              onSelect={() => runCommand(() => setTheme('system'))}
            >
              <Laptop />
              <span>System</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
