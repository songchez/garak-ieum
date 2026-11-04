import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine, InstrumentId, Track } from '../core/types'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, instrumentDef, type InstrumentDef } from '../core/instruments'
import { Icon } from './Icon'
import { trackIcon } from './TrackInspector'
import { WAVETABLE_HOST_REQUIRED } from '../audio/instrumentSupport'
import { useInstrumentAvailability } from './useInstrumentAvailability'
import { pluginKey, usePluginCatalog } from './usePluginCatalog'
import type { NativePluginDescriptor } from '../audio/native/contracts'
import './Inspector.css'

export interface LibraryProps {
  focusedTrack: Track | undefined
  engine: AudioEngine
  /** Replaces the focused instrument track's patch. */
  onSelectPatch: (instrumentId: InstrumentId) => void
  onPreview: (instrumentId: InstrumentId) => void
  onAddTrack: (instrumentId: InstrumentId) => void
  /** VST3 instruments are instruments too: they replace the focused track's source or start a new track. */
  onSelectPlugin?: (plugin: NativePluginDescriptor) => void
  onAddPluginTrack?: (plugin: NativePluginDescriptor) => void
  onOpenPluginSettings?: () => void
}

const sectionOf = (def: InstrumentDef) => Math.max(0, INSTRUMENT_SECTIONS.findIndex(s => s.categories.includes(def.category)))
const matches = (def: InstrumentDef, q: string) => (def.name + def.nameKo + def.type + def.description).toLowerCase().includes(q)

export function Library({ focusedTrack, engine, onSelectPatch, onPreview, onAddTrack, onSelectPlugin, onAddPluginTrack, onOpenPluginSettings }: LibraryProps) {
  const canPlay = useInstrumentAvailability(engine)
  const catalog = usePluginCatalog(engine as Parameters<typeof usePluginCatalog>[0])
  const pluginInstruments = catalog.plugins.filter(plugin => plugin.isInstrument)
  const vstCategory = INSTRUMENT_SECTIONS.length
  const currentPlugin = focusedTrack?.kind === 'instrument' ? focusedTrack.pluginInstrument : undefined
  const [search, setSearch] = useState('')
  const current = focusedTrack?.kind === 'instrument' && !focusedTrack.pluginInstrument ? instrumentDef(focusedTrack.instrument) : undefined
  const [category, setCategory] = useState(() => focusedTrack?.kind === 'instrument' && focusedTrack.pluginInstrument && catalog.supported ? INSTRUMENT_SECTIONS.length : current ? sectionOf(current) : 0)
  const listRef = useRef<HTMLDivElement>(null)
  const canSelect = focusedTrack?.kind === 'instrument'
  const query = search.trim().toLowerCase()
  const patches = useMemo(() => query ? INSTRUMENTS.filter(i => matches(i, query)) : category >= INSTRUMENT_SECTIONS.length ? [] : INSTRUMENTS.filter(i => INSTRUMENT_SECTIONS[category].categories.includes(i.category)), [query, category])
  const plugins = query ? pluginInstruments.filter(plugin => (plugin.name + plugin.vendor).toLowerCase().includes(query)) : category === vstCategory ? pluginInstruments : []
  const pluginCurrent = (plugin: NativePluginDescriptor) => !!currentPlugin && pluginKey(currentPlugin) === pluginKey(plugin)
  // Following the focused track's patch like Logic: the category column jumps to where the patch lives.
  useEffect(() => { if (current) setCategory(sectionOf(current)); else if (currentPlugin && catalog.supported) setCategory(vstCategory) }, [current, currentPlugin, catalog.supported, vstCategory])
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.library-patch.current')?.scrollIntoView({ block: 'nearest' }) }, [current, category, query])
  function keyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (e.target instanceof HTMLInputElement && e.target.type === 'text' && !patches.length) return
    e.preventDefault()
    const index = current ? patches.findIndex(p => p.id === current.id) : -1
    const next = patches[Math.max(0, Math.min(patches.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next && canSelect && next.id !== current?.id) onSelectPatch(next.id)
  }
  return <div className="library" aria-label="라이브러리" tabIndex={-1} onKeyDown={keyDown}>
    <div className="library-head">
      <span className="library-head-icon" style={{ color: focusedTrack?.color ?? 'var(--ink-45)' }}><Icon name={focusedTrack ? trackIcon(focusedTrack) : 'keys'} size={18} /></span>
      <div className="library-head-text">{currentPlugin ? <><strong>{currentPlugin.name}</strong><span>VST3 악기</span></> : current ? <><strong>{current.name}</strong><span>{current.nameKo} · {current.type}</span></> : <><strong>{focusedTrack ? focusedTrack.name : '라이브러리'}</strong><span>{focusedTrack?.kind === 'audio' ? '오디오 트랙에는 패치가 없습니다' : '악기 트랙을 선택하세요'}</span></>}</div>
    </div>
    <div className="library-search"><Icon name="search" size={13} /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="사운드 검색" aria-label="사운드 검색" /></div>
    <div className={`library-cols ${query ? 'flat' : ''} ${canSelect ? '' : 'dim'}`} ref={listRef}>
      {!query && <ul className="library-cats" role="listbox" aria-label="카테고리">{INSTRUMENT_SECTIONS.map((section, i) => <li key={section.title}><button type="button" role="option" aria-selected={i === category} className={i === category ? 'active' : ''} onClick={() => setCategory(i)}>{section.title}<Icon name="right" size={10} /></button></li>)}
        {catalog.supported && <li><button type="button" role="option" aria-selected={category === vstCategory} className={category === vstCategory ? 'active' : ''} onClick={() => setCategory(vstCategory)}>VST3<Icon name="right" size={10} /></button></li>}</ul>}
      <ul className="library-patches" role="listbox" aria-label="패치">
        {patches.map(def => <li key={def.id} className={`library-patch ${current?.id === def.id ? 'current' : ''}`} role="option" aria-selected={current?.id === def.id}>
          <button type="button" className="library-preview" onClick={() => onPreview(def.id)} disabled={!canPlay( def.id)} title={canPlay( def.id) ? `${def.name} 미리 듣기` : WAVETABLE_HOST_REQUIRED} aria-label={`${def.name} 미리 듣기`} style={{ color: def.color }}><Icon name={def.icon} size={15} /></button>
          <button type="button" className="library-patch-name" onClick={() => { if (canSelect) onSelectPatch(def.id) }} disabled={!canSelect} title={canSelect ? def.description : '악기 트랙을 선택하면 패치를 바꿀 수 있습니다'}><strong>{def.name}</strong><span>{def.nameKo}</span></button>
          <button type="button" className="library-add" onClick={() => onAddTrack(def.id)} title={`${def.name} 트랙 추가`} aria-label={`${def.name} 트랙 추가`}><Icon name="plus" size={11} />트랙</button>
        </li>)}
        {plugins.map(plugin => <li key={pluginKey(plugin)} className={`library-patch ${pluginCurrent(plugin) ? 'current' : ''}`} role="option" aria-selected={pluginCurrent(plugin)}>
          <span className="library-preview" aria-hidden="true"><Icon name="plug" size={15} /></span>
          <button type="button" className="library-patch-name" onClick={() => { if (canSelect) onSelectPlugin?.(plugin) }} disabled={!canSelect} title={canSelect ? `${plugin.name}를 이 트랙의 악기로` : '악기 트랙을 선택하면 악기를 바꿀 수 있습니다'}><strong>{plugin.name}</strong><span>VST3{plugin.vendor ? ` · ${plugin.vendor}` : ''}</span></button>
          <button type="button" className="library-add" onClick={() => onAddPluginTrack?.(plugin)} title={`${plugin.name} 트랙 추가`} aria-label={`${plugin.name} 트랙 추가`}><Icon name="plus" size={11} />트랙</button>
        </li>)}
        {category === vstCategory && !query && !pluginInstruments.length && <li className="library-empty">등록된 VST3 악기가 없습니다{onOpenPluginSettings && <><br/><button type="button" className="library-register" onClick={onOpenPluginSettings}>VST3 등록…</button></>}</li>}
        {!patches.length && !plugins.length && (query || category !== vstCategory) && <li className="library-empty">일치하는 사운드가 없습니다</li>}
      </ul>
    </div>
    {!canSelect && <p className="library-hint">{focusedTrack?.kind === 'audio' ? '오디오 트랙에는 패치가 없습니다. + 트랙으로 악기 트랙을 추가할 수 있습니다.' : '악기 트랙을 선택하세요'}</p>}
  </div>
}
