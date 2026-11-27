import { useLayoutEffect, useState } from 'react'
import { parseAccountCapability } from './capability'

/** Callback-scoped memory; never retain the capability in history or storage. */
export function useAccountCapability() {
  const [capability, setCapability] = useState(() =>
    parseAccountCapability(window.location.hash)
  )

  useLayoutEffect(() => {
    if (!window.location.hash) return
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search
    )
  }, [])

  return {
    capability,
    clearCapability: () => setCapability(null),
  }
}
