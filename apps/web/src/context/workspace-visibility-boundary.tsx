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
  const portalContainerRef = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const portalContainer = portalContainerRef.current
    if (!portalContainer) return

    setContainer((current) =>
      current === portalContainer ? current : portalContainer
    )
  }, [])

  return (
    <div
      data-slot='workspace-visibility-boundary'
      hidden={hidden}
      style={{ display: hidden ? 'none' : 'contents' }}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      <div
        ref={portalContainerRef}
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
