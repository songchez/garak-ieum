import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DesktopBridge } from '../../desktop/contracts'
import { BRAND } from '../brand'
import { getThemeSnapshot, subscribeTheme, themeDefinition } from '../core/theme'
import { getDesktopBridge } from '../platform/desktop'
import { HeaderMenuSlot, HeaderMenusProvider } from './HeaderMenus'
import './DesktopFrame.css'

type WindowControlsOverlay = EventTarget & { readonly visible: boolean }
function windowControlsOverlay(): WindowControlsOverlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
}

function DesktopTitleBar({ desktop }: { desktop: DesktopBridge }) {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  const [title, setTitle] = useState(document.title)
  const [focused, setFocused] = useState(document.hasFocus())
  const [captionVisible, setCaptionVisible] = useState(windowControlsOverlay()?.visible)
  useEffect(() => {
    const overlay = windowControlsOverlay()
    if (!overlay) return
    const update = () => setCaptionVisible(overlay.visible)
    update()
    overlay.addEventListener('geometrychange', update)
    return () => overlay.removeEventListener('geometrychange', update)
  }, [])
  useEffect(() => {
    const updateTitle = () => setTitle(document.title)
    const observer = new MutationObserver(updateTitle)
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    updateTitle()
    const focus = () => setFocused(true), blur = () => setFocused(false)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => { observer.disconnect(); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur) }
  }, [])
  useEffect(() => {
    const colors = themeDefinition(theme).colors
    void desktop.windowChrome?.setColors({ background: colors.panel, foreground: colors.text }).catch(() => {
      // Caption controls still work with their initial colors if the window is closing.
    })
  }, [desktop, theme])
  const suffix = ` · ${BRAND.name}`
  const displayTitle = title.endsWith(suffix) ? title.slice(0, -suffix.length) : title
  return <div className="desktop-titlebar" data-focused={focused} data-caption-visible={captionVisible} aria-label="창 제목 표시줄">
    <div className="desktop-titlebar-content">
      <div className="desktop-titlebar-leading">
        <img src={BRAND.mark} width="16" height="16" alt=""/>
        <span className="desktop-titlebar-brand">{BRAND.name}</span>
        <HeaderMenuSlot location="desktop"/>
      </div>
      <span className="desktop-titlebar-title" title={title}>{displayTitle}</span>
      <span aria-hidden="true"/>
    </div>
  </div>
}

/** Browser previews keep the normal page; the installed app owns the window chrome. */
export function DesktopFrame({ children }: { children: ReactNode }) {
  const desktop = getDesktopBridge()
  if (!desktop?.windowChrome) return <HeaderMenusProvider location="browser">{children}</HeaderMenusProvider>
  return <HeaderMenusProvider location="desktop"><div className="desktop-window" data-platform={desktop.platform}>
    <DesktopTitleBar desktop={desktop}/>
    <div className="desktop-window-content">{children}</div>
  </div></HeaderMenusProvider>
}
