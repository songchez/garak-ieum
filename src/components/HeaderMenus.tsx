import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './HeaderMenus.css'

type HeaderLocation = 'desktop' | 'browser'
const HeaderMenusContext = createContext<{
  location: HeaderLocation
  target: HTMLDivElement | null
  setTarget: (target: HTMLDivElement | null) => void
} | null>(null)

/** Menu state stays with its editor; only its buttons move into the app header. */
export function HeaderMenusProvider({ location, children }: { location: HeaderLocation; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ location, target, setTarget }), [location, target])
  return <HeaderMenusContext.Provider value={value}>{children}</HeaderMenusContext.Provider>
}

export function HeaderMenuSlot({ location }: { location: HeaderLocation }) {
  const context = useContext(HeaderMenusContext)
  if (context?.location !== location) return null
  return <div className="header-menu-slot" ref={context.setTarget}/>
}

export function HeaderMenus({ children }: { children: ReactNode }) {
  const target = useContext(HeaderMenusContext)?.target
  return target ? createPortal(children, target) : null
}
