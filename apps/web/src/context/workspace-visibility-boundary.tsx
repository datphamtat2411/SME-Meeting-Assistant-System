import {
  Activity,
  createContext,
  useContext,
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
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  return (
    <div
      className={hidden ? 'hidden' : 'contents'}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      <div ref={setContainer} className='contents' />
      {container && (
        <PortalContainerContext value={container}>
          <Activity mode={hidden ? 'hidden' : 'visible'}>{children}</Activity>
        </PortalContainerContext>
      )}
    </div>
  )
}
