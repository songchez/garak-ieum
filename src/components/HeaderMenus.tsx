import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './HeaderMenus.css'

type HeaderLocation = 'desktop' | 'browser'
/** File · (편집 · 기능 · 보기) · 도움말 — one menu bar, filled by the components that own each menu's state. */
export type HeaderMenuPart = 'file' | 'editor' | 'help'
type Targets = Record<HeaderMenuPart, HTMLDivElement | null>
const EMPTY: Targets = { file: null, editor: null, help: null }
const HeaderMenusContext = createContext<{
  location: HeaderLocation
  targets: Targets
  refs: Record<HeaderMenuPart, (target: HTMLDivElement | null) => void>
} | null>(null)

/** Menu state stays with its owner; only its buttons move into the app header. */
export function HeaderMenusProvider({ location, children }: { location: HeaderLocation; children: ReactNode }) {
  const [targets, setTargets] = useState<Targets>(EMPTY)
  // Stable ref callbacks: a new function per render would detach and reattach each part.
  const [refs] = useState(() => {
    const set = (part: HeaderMenuPart) => (target: HTMLDivElement | null) => setTargets(current => current[part] === target ? current : { ...current, [part]: target })
    return { file: set('file'), editor: set('editor'), help: set('help') }
  })
  const value = useMemo(() => ({ location, targets, refs }), [location, targets, refs])
  return <HeaderMenusContext.Provider value={value}>{children}</HeaderMenusContext.Provider>
}

/** Where the window's menu bar lives: the desktop title bar, or the studio header in a browser. */
export function useHeaderLocation(): HeaderLocation | undefined {
  return useContext(HeaderMenusContext)?.location
}

export function HeaderMenuSlot({ location }: { location: HeaderLocation }) {
  const context = useContext(HeaderMenusContext)
  if (context?.location !== location) return null
  return <div className="header-menu-slot" role="group" aria-label="메뉴 막대">
    <div className="header-menu-part" ref={context.refs.file}/>
    <div className="header-menu-part" ref={context.refs.editor}/>
    <div className="header-menu-part" ref={context.refs.help}/>
  </div>
}

export function HeaderMenus({ part = 'editor', children }: { part?: HeaderMenuPart; children: ReactNode }) {
  const target = useContext(HeaderMenusContext)?.targets[part]
  return target ? createPortal(children, target) : null
}
