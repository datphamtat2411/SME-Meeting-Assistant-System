import {
  Activity,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

const PortalContainerContext = createContext<HTMLElement | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export function usePortalContainer() {
  return useContext(PortalContainerContext)
}

/**
 * Keep protected overlays in the same DOM boundary as their owning workspace.
 * The portal host stays mounted while Activity disconnects descendant effects.
 */
export function WorkspaceVisibilityBoundary({
  hidden,
  children,
}: {
  hidden: boolean
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  // Publish the committed host once. Detaching refs must not enqueue state
  // updates, and visibility changes must never replace the portal target.
  useLayoutEffect(() => {
    setContainer(hostRef.current)
  }, [])

  return (
    <div
      data-slot='workspace-visibility-boundary'
      hidden={hidden}
      style={{ display: hidden ? 'none' : 'contents' }}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      {/* The host is outside Activity, but inside the same DOM shield. */}
      <div
        ref={hostRef}
        data-slot='workspace-portal-host'
        style={{ display: 'contents' }}
      />
      {container && (
        <PortalContainerContext value={container}>
          <Activity mode={hidden ? 'hidden' : 'visible'}>{children}</Activity>
        </PortalContainerContext>
      )}
    </div>
  )
}
