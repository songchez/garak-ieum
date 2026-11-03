import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THEME, getThemeSnapshot, initializeTheme, loadTheme, setTheme, subscribeTheme, THEMES, THEME_STORAGE_KEY } from './theme'

const saved=new Map<string,string>()
const styles=new Map<string,string>()
const root={dataset:{} as Record<string,string>,style:{colorScheme:'',setProperty:(name:string,value:string)=>styles.set(name,value),removeProperty:(name:string)=>styles.delete(name)}}
beforeEach(()=>{
  saved.clear();styles.clear();root.dataset={};root.style.colorScheme=''
  vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)})
  vi.stubGlobal('document',{documentElement:root})
  initializeTheme()
})
afterEach(()=>vi.unstubAllGlobals())

describe('browser appearance preferences',()=>{
  it('uses the existing theme for absent, damaged or unknown preferences',()=>{
    expect(loadTheme()).toBe(DEFAULT_THEME)
    for(const invalid of ['','{broken','"porcelain"','future-theme']){saved.set(THEME_STORAGE_KEY,invalid);expect(loadTheme()).toBe(DEFAULT_THEME)}
    vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('denied')}})
    expect(loadTheme()).toBe(DEFAULT_THEME)
  })

  it('restores a stored choice and applies actual CSS roles before notifying subscribers',()=>{
    saved.set(THEME_STORAGE_KEY,'porcelain')
    const listener=vi.fn(()=>{
      expect(root.dataset.theme).toBe('porcelain')
      expect(root.style.colorScheme).toBe('light')
      expect(styles.get('--surface-canvas')).toBe('#f8f6f0')
      expect(getThemeSnapshot()).toBe('porcelain')
    })
    const unsubscribe=subscribeTheme(listener)
    initializeTheme()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    setTheme('celadon')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('persists only a valid appearance ID and preserves the current session on write failure',()=>{
    expect(setTheme('natural-dyes')).toEqual({persisted:true})
    expect([...saved.entries()]).toEqual([[THEME_STORAGE_KEY,'natural-dyes']])
    vi.stubGlobal('localStorage',{setItem:()=>{throw new Error('full')}})
    expect(setTheme('earthy')).toEqual({persisted:false})
    expect(getThemeSnapshot()).toBe('earthy')
    expect(root.dataset.theme).toBe('earthy')
    expect(root.style.colorScheme).toBe('dark')
    expect(()=>setTheme('url(https://invalid)' as never)).toThrow()
    expect(getThemeSnapshot()).toBe('earthy')
  })

  it('replaces all palette roles and restores the original compatibility ramp',()=>{
    setTheme('porcelain')
    expect(styles.get('--theme-palette-5')).toBe('#2A4B7C')
    setTheme('celadon')
    expect(styles.has('--theme-palette-5')).toBe(false)
    expect(styles.get('--text-primary')).toBe('#3c4340')
    setTheme(DEFAULT_THEME)
    expect(styles.has('--ink-10')).toBe(false)
    expect(styles.has('--text-primary')).toBe(false)
    expect(styles.get('--meter-low')).toBe('#83bd9c')
    expect(root.dataset.themeMode).toBe('dark')
  })

  it('clears light materials and grid colors when returning to dark themes',()=>{
    setTheme('porcelain')
    expect(styles.get('--control-border')).toBe(THEMES.find(theme=>theme.id==='porcelain')!.colors.borderStrong)
    expect(styles.get('--grid-major')).toMatch(/^#[0-9a-f]{6}$/)
    expect(styles.get('--hanji-surface')).toBe('#f8f6f0')
    setTheme('earthy')
    expect(styles.get('--grid-major')).toBe('color-mix(in srgb,var(--text-muted) 21%,transparent)')
    expect(styles.get('--control-border')).toBe(THEMES.find(theme=>theme.id==='earthy')!.colors.border)
    setTheme(DEFAULT_THEME)
    for(const token of ['--grid-major','--grid-minor','--hanji-surface','--paper-edge','--hanok-frame','--control-border']){
      expect(styles.has(token),`${token} must return to its CSS default`).toBe(false)
    }
  })
})

function luminance(hex:string):number {
  const channels=hex.slice(1).match(/../g)!.map(value=>Number.parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4)
  return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722
}
function contrast(a:string,b:string):number {const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}

describe('theme role contrast',()=>{
  it.each(THEMES)('$id keeps small text readable across regular, hover and selected surfaces',theme=>{
    const c=theme.colors
    for(const foreground of ['text','secondary','muted'] as const)for(const surface of ['canvas','panel','raised','overlay','hover','selected','input'] as const){
      expect(contrast(c[foreground],c[surface]),`${theme.id}: ${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    for(const surface of ['canvas','panel','raised','overlay','hover','selected','input'] as const){
      expect(contrast(c.accent,c[surface]),`${theme.id}: focus on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(THEMES)('$id gives filled controls readable foregrounds',theme=>{
    const c=theme.colors
    expect(contrast(c.inverse,c.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.inverse,c.brand)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.onPlay,c.play)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(THEMES.filter(theme=>theme.id!==DEFAULT_THEME))('$id keeps colored action and status text readable',theme=>{
    const c=theme.colors
    for(const foreground of ['accent','accentHover','accentStrong','brand','brandHover','brass','play','playHover','success','danger','warning'] as const)for(const surface of ['canvas','panel','raised','overlay','hover','selected','input'] as const){
      expect(contrast(c[foreground],c[surface]),`${theme.id}: ${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(THEMES.filter(theme=>theme.mode==='light'))('$id distinguishes control boundaries and selection in a bright workspace',theme=>{
    const c=theme.colors
    for(const surface of ['canvas','canvasAlt','panel','panelSoft','raised','overlay','hover','selected','input'] as const){
      expect(contrast(theme.tokens['--control-border'],c[surface]),`${theme.id}: control on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.accentBorder,c[surface]),`${theme.id}: selection on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.muted,c[surface]),`${theme.id}: hint on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    const major=contrast(theme.tokens['--grid-major'],c.canvas)
    const minor=contrast(theme.tokens['--grid-minor'],c.canvas)
    expect(major,'bar lines must remain distinguishable from subdivisions').toBeGreaterThanOrEqual(2)
    expect(minor).toBeGreaterThanOrEqual(1.25)
    expect(major).toBeGreaterThan(minor)
    expect(contrast(c.onRecord,c.record)).toBeGreaterThanOrEqual(4.5)
  })
})
