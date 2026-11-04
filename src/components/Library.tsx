import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine, InstrumentId, Track } from '../core/types'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, instrumentDef, type InstrumentDef } from '../core/instruments'
import { Icon } from './Icon'
import { trackIcon } from './TrackInspector'
import { WAVETABLE_HOST_REQUIRED } from '../audio/instrumentSupport'
import { useInstrumentAvailability } from './useInstrumentAvailability'
import './Inspector.css'

export interface LibraryProps {
  focusedTrack: Track | undefined
  engine: AudioEngine
  /** Replaces the focused instrument track's patch. */
  onSelectPatch: (instrumentId: InstrumentId) => void
  onPreview: (instrumentId: InstrumentId) => void
  onAddTrack: (instrumentId: InstrumentId) => void
}

const sectionOf = (def: InstrumentDef) => Math.max(0, INSTRUMENT_SECTIONS.findIndex(s => s.categories.includes(def.category)))
const matches = (def: InstrumentDef, q: string) => (def.name + def.nameKo + def.type + def.description).toLowerCase().includes(q)

export function Library({ focusedTrack, engine, onSelectPatch, onPreview, onAddTrack }: LibraryProps) {
  const canPlay = useInstrumentAvailability(engine)
  const [search, setSearch] = useState('')
  const current = focusedTrack?.kind === 'instrument' ? instrumentDef(focusedTrack.instrument) : undefined
  const [category, setCategory] = useState(() => current ? sectionOf(current) : 0)
  const listRef = useRef<HTMLDivElement>(null)
  const canSelect = focusedTrack?.kind === 'instrument'
  const query = search.trim().toLowerCase()
  const patches = useMemo(() => query ? INSTRUMENTS.filter(i => matches(i, query)) : INSTRUMENTS.filter(i => INSTRUMENT_SECTIONS[category].categories.includes(i.category)), [query, category])
  // Following the focused track's patch like Logic: the category column jumps to where the patch lives.
  useEffect(() => { if (current) setCategory(sectionOf(current)) }, [current])
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
      <div className="library-head-text">{current ? <><strong>{current.name}</strong><span>{current.nameKo} · {current.type}</span></> : <><strong>{focusedTrack ? focusedTrack.name : '라이브러리'}</strong><span>{focusedTrack?.kind === 'audio' ? '오디오 트랙에는 패치가 없습니다' : '악기 트랙을 선택하세요'}</span></>}</div>
    </div>
    <div className="library-search"><Icon name="search" size={13} /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="사운드 검색" aria-label="사운드 검색" /></div>
    <div className={`library-cols ${query ? 'flat' : ''} ${canSelect ? '' : 'dim'}`} ref={listRef}>
      {!query && <ul className="library-cats" role="listbox" aria-label="카테고리">{INSTRUMENT_SECTIONS.map((section, i) => <li key={section.title}><button type="button" role="option" aria-selected={i === category} className={i === category ? 'active' : ''} onClick={() => setCategory(i)}>{section.title}<Icon name="right" size={10} /></button></li>)}</ul>}
      <ul className="library-patches" role="listbox" aria-label="패치">
        {patches.map(def => <li key={def.id} className={`library-patch ${current?.id === def.id ? 'current' : ''}`} role="option" aria-selected={current?.id === def.id}>
          <button type="button" className="library-preview" onClick={() => onPreview(def.id)} disabled={!canPlay( def.id)} title={canPlay( def.id) ? `${def.name} 미리 듣기` : WAVETABLE_HOST_REQUIRED} aria-label={`${def.name} 미리 듣기`} style={{ color: def.color }}><Icon name={def.icon} size={15} /></button>
          <button type="button" className="library-patch-name" onClick={() => { if (canSelect) onSelectPatch(def.id) }} disabled={!canSelect} title={canSelect ? def.description : '악기 트랙을 선택하면 패치를 바꿀 수 있습니다'}><strong>{def.name}</strong><span>{def.nameKo}</span></button>
          <button type="button" className="library-add" onClick={() => onAddTrack(def.id)} title={`${def.name} 트랙 추가`} aria-label={`${def.name} 트랙 추가`}><Icon name="plus" size={11} />트랙</button>
        </li>)}
        {!patches.length && <li className="library-empty">일치하는 사운드가 없습니다</li>}
      </ul>
    </div>
    {!canSelect && <p className="library-hint">{focusedTrack?.kind === 'audio' ? '오디오 트랙에는 패치가 없습니다. + 트랙으로 악기 트랙을 추가할 수 있습니다.' : '악기 트랙을 선택하세요'}</p>}
  </div>
}
