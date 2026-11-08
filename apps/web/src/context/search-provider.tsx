import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { CommandMenu } from '@/components/command-menu'

type SearchContextType = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  openSearch: (trigger?: HTMLElement | null) => void
}

const SearchContext = createContext<SearchContextType | null>(null)

type SearchProviderProps = {
  children: React.ReactNode
}

export function SearchProvider({ children }: SearchProviderProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)

  const openSearch = useCallback((trigger?: HTMLElement | null) => {
    triggerRef.current =
      trigger ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    setOpen(true)
  }, [])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((isOpen) => {
          if (!isOpen) {
            triggerRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null
          }
          return !isOpen
        })
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  useEffect(() => {
    if (open || !triggerRef.current) return

    const trigger = triggerRef.current
    const frameId = window.requestAnimationFrame(() => {
      if (trigger.isConnected) {
        trigger.focus()
      }
      if (triggerRef.current === trigger) {
        triggerRef.current = null
      }
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [open])

  return (
    <SearchContext value={{ open, setOpen, openSearch }}>
      {children}
      <CommandMenu />
    </SearchContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useSearch = () => {
  const searchContext = useContext(SearchContext)

  if (!searchContext) {
    throw new Error('useSearch has to be used within SearchProvider')
  }

  return searchContext
}
