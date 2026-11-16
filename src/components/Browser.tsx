import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioAsset, AudioEngine, Track } from '../core/types'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, instrumentDef, type InstrumentDef } from '../core/instruments'
import { EFFECT_DEFS } from '../core/devices'
import { SIGIMSAE_CATEGORIES, SIGIMSAE_VARIANTS, searchVariants, variantsIn, type SigimsaeVariant } from '../core/sigimsaeVariants'
import { effectDeviceName } from '../core/sigimsaeDevices'
import { writeLibraryDrag, type LibraryItem } from '../core/libraryDrag'
import type { NativePluginDescriptor } from '../audio/native/contracts'
import { instrumentUnavailableReason } from '../audio/instrumentSupport'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import { useInstrumentAvailability } from './useInstrumentAvailability'
import { pluginKey, usePluginCatalog } from './usePluginCatalog'
import './Inspector.css'
import './Browser.css'

export type LibraryTab = 'instrument' | 'effect' | 'audio'

export interface BrowserProps {
  assets: Map<string, AudioAsset>
  engine: AudioEngine
  /** Where a click lands: instruments replace its sound, effects join its chain, audio goes on it. */
  focusedTrack: Track | undefined
  tab: LibraryTab
  onTabChange: (tab: LibraryTab) => void
  /** `newTrack` asks for a fresh track instead of the focused one. */
  onUse: (item: LibraryItem, opts?: { newTrack?: boolean }) => void
  onPreview: (instrumentId: string) => void
  onImport: () => void
  onOpenPluginSettings?: () => void
  pluginsLocked?: boolean
  /** Warp renders and other derived assets: the list shows only the files the user brought in. */
  hiddenAssetIds?: ReadonlySet<string>
}

/** 시김새 (gugak tone ornamentation) is the app's word for effects; the tab spells out "이펙트" for newcomers. */
const TABS: { id: LibraryTab; label: string; hint: string; icon: string }[] = [
  { id: 'instrument', label: '악기', hint: '', icon: 'keys' },
  { id: 'effect', label: '시김새', hint: '이펙트', icon: 'plug' },
  { id: 'audio', label: '오디오', hint: '', icon: 'wave' },
]

/** Effect categories for the column browser; each lists library variants (sigimsaeVariants.ts). */
const EFFECT_SECTIONS = SIGIMSAE_CATEGORIES.map(title => ({ title, variants: variantsIn(title) }))
const VST = INSTRUMENT_SECTIONS.length
const VST_FX = EFFECT_SECTIONS.length

const has = (q: string, ...parts: (string | undefined)[]) => !q || parts.join(' ').toLowerCase().includes(q)
const dragProps = (item: LibraryItem) => ({ draggable: true, onDragStart: (e: React.DragEvent) => writeLibraryDrag(e.dataTransfer, item) })
const sectionOf = (def: InstrumentDef) => Math.max(0, INSTRUMENT_SECTIONS.findIndex(s => s.categories.includes(def.category)))

/** The library (F, left edge): a Logic-style column browser for instruments and effects (built-in and VST3), plus project audio. */
export function Browser({ assets, engine, focusedTrack, tab, onTabChange, onUse, onPreview, onImport, onOpenPluginSettings, pluginsLocked, hiddenAssetIds }: BrowserProps) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const canPlay = useInstrumentAvailability(engine)
  const catalog = usePluginCatalog(engine as Parameters<typeof usePluginCatalog>[0])
  const instrumentTrack = focusedTrack?.kind === 'instrument' ? focusedTrack : undefined
  const currentPatch = instrumentTrack && !instrumentTrack.pluginInstrument ? instrumentDef(instrumentTrack.instrument) : undefined
  const currentPlugin = instrumentTrack?.pluginInstrument
  const [instCat, setInstCat] = useState(() => currentPlugin ? VST : currentPatch ? sectionOf(currentPatch) : 0)
  const [fxCat, setFxCat] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  // The instrument column follows the focused track's patch, as the Logic library does.
  useEffect(() => { if (currentPatch) setInstCat(sectionOf(currentPatch)); else if (currentPlugin) setInstCat(VST) }, [currentPatch, currentPlugin])
  // Audio tracks have no instrument: focusing one turns the browser to its effects.
  const focusedId = focusedTrack?.id, focusedKind = focusedTrack?.kind
  useEffect(() => { if (focusedKind === 'audio' && tab === 'instrument') onTabChange('effect') }, [focusedId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.library-patch.current')?.scrollIntoView({ block: 'nearest' }) }, [currentPatch, instCat, q, tab])

  const plugins = (instrument: boolean) => catalog.plugins.filter(p => p.isInstrument === instrument && has(q, p.name, p.vendor, 'vst3'))
  const instruments = useMemo(() => q ? INSTRUMENTS.filter(d => has(q, d.name, d.nameKo, d.type, d.description)) : instCat < VST ? INSTRUMENTS.filter(d => INSTRUMENT_SECTIONS[instCat].categories.includes(d.category)) : [], [q, instCat])
  const effects = q ? searchVariants(q) : fxCat < VST_FX ? EFFECT_SECTIONS[fxCat].variants : []
  const shownPlugins = tab === 'instrument' ? (q || instCat === VST ? plugins(true) : []) : tab === 'effect' ? (q || fxCat === VST_FX ? plugins(false) : []) : []
  const vstOpen = !q && (tab === 'instrument' ? instCat === VST : fxCat === VST_FX)
  const originals = Array.from(assets.values()).filter(a => !hiddenAssetIds?.has(a.id) && !a.name.includes(' · 워프 '))
  const audio = originals.filter(a => has(q, a.name))
  const counts: Record<LibraryTab, number> = { instrument: INSTRUMENTS.length + catalog.plugins.filter(p => p.isInstrument).length, effect: SIGIMSAE_VARIANTS.length + catalog.plugins.filter(p => !p.isInstrument).length, audio: originals.length }
  const deviceCount = (match: (type: string, key?: string) => boolean) => focusedTrack?.devices.filter(d => match(d.type, d.type === 'vst3' ? pluginKey(d) : undefined)).length ?? 0

  const target = tab === 'instrument'
    ? instrumentTrack ? '클릭: 이 트랙의 악기 바꾸기 · + 새 트랙' : '클릭: 새 악기 트랙 만들기'
    : tab === 'effect'
      ? focusedTrack ? '클릭: 이 트랙의 시김새 체인 끝에 추가' : '트랙을 선택하거나 트랙 위로 끌어 놓으세요'
      : focusedTrack?.kind === 'audio' ? '클릭: 이 트랙의 재생 위치에 추가' : '클릭: 새 오디오 트랙의 재생 위치에 추가'

  function keyDown(e: React.KeyboardEvent) {
    if (tab !== 'instrument' || !instrumentTrack || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !instruments.length) return
    e.preventDefault()
    const index = currentPatch ? instruments.findIndex(d => d.id === currentPatch.id) : -1
    const next = instruments[Math.max(0, Math.min(instruments.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next && next.id !== currentPatch?.id) onUse({ kind: 'instrument', instrument: next.id })
  }

  function instrumentRow(def: InstrumentDef) {
    const playable = canPlay(def.id), current = currentPatch?.id === def.id
    return <li key={def.id} className={`library-patch lib-row${current ? ' current' : ''}`} role="option" aria-selected={current} {...dragProps({ kind: 'instrument', instrument: def.id })}>
      <button type="button" className="library-preview" onClick={() => onPreview(def.id)} disabled={!playable} title={playable ? `${def.name} 미리 듣기` : instrumentUnavailableReason(engine, def.id)} aria-label={`${def.name} 미리 듣기`} style={{ color: def.color }}><Icon name={def.icon} size={15} /></button>
      <button type="button" className="library-patch-name" onClick={() => onUse({ kind: 'instrument', instrument: def.id })} title={`${def.description}\n끌어서 트랙이나 빈 곳에 놓을 수 있습니다`}><strong>{def.name}</strong><span>{def.nameKo} · {def.type}</span></button>
      <button type="button" className="library-add" onClick={() => onUse({ kind: 'instrument', instrument: def.id }, { newTrack: true })} title={`${def.name} 트랙 추가`} aria-label={`${def.name} 새 트랙`}><Icon name="plus" size={11} />트랙</button>
    </li>
  }

  function effectRow(variant: SigimsaeVariant) {
    const type = variant.effectType
    const item: LibraryItem = { kind: 'effect', effectType: type, variantId: variant.id }
    const used = focusedTrack?.devices.filter(d => d.type !== 'vst3' && d.type === type && effectDeviceName(d) === variant.name).length ?? 0
    const module = EFFECT_DEFS[type]
    return <li key={variant.id} className="library-patch lib-row" role="option" aria-selected={false} {...dragProps(item)}>
      <span className="library-preview lib-fx-icon" aria-hidden="true"><Icon name={type} size={14} /></span>
      <button type="button" className="library-patch-name" onClick={() => onUse(item)} title={`${variant.name} · ${variant.label}
${module.name} 모듈 · 끌어서 트랙이나 시김새 체인에 놓을 수 있습니다`}><strong>{variant.name}</strong><span>{variant.label}{q ? ` · ${variant.category}` : ''}</span></button>
      {used > 0 && <em className="lib-card-count" title="선택 트랙에서 사용 중">×{used}</em>}
    </li>
  }

  function pluginRow(plugin: NativePluginDescriptor) {
    const item: LibraryItem = { kind: 'plugin', plugin }
    const key = pluginKey(plugin)
    const current = plugin.isInstrument && !!currentPlugin && pluginKey(currentPlugin) === key
    const used = plugin.isInstrument ? 0 : deviceCount((type, k) => type === 'vst3' && k === key)
    return <li key={key} className={`library-patch lib-row${current ? ' current' : ''}`} role="option" aria-selected={current} {...dragProps(item)}>
      <span className="library-preview lib-fx-icon" aria-hidden="true"><Icon name="plug" size={14} /></span>
      <button type="button" className="library-patch-name" disabled={pluginsLocked} onClick={() => onUse(item)} title={`${plugin.name}${plugin.vendor ? ` · ${plugin.vendor}` : ''}`}><strong>{plugin.name}</strong><span>VST3{plugin.vendor ? ` · ${plugin.vendor}` : ''}</span></button>
      {used > 0 && <em className="lib-card-count" title="선택 트랙에서 사용 중">×{used}</em>}
      {plugin.isInstrument && <button type="button" className="library-add" disabled={pluginsLocked} onClick={() => onUse(item, { newTrack: true })} title={`${plugin.name} 트랙 추가`} aria-label={`${plugin.name} 새 트랙`}><Icon name="plus" size={11} />트랙</button>}
    </li>
  }

  const what = tab === 'instrument' ? '악기' : '시김새'
  const vstState = !vstOpen ? null
    : !catalog.supported ? <li className="library-empty lib-vst-empty">VST3 {what}는 데스크톱 앱에서 쓸 수 있습니다.<br />등록하면 여기에 나타납니다.</li>
      : !shownPlugins.length ? <li className="library-empty lib-vst-empty">등록된 VST3 {what}가 없습니다{onOpenPluginSettings && <button type="button" className="library-register" onClick={onOpenPluginSettings}>VST3 등록…</button>}</li>
        : onOpenPluginSettings ? <li className="lib-vst-manage"><button type="button" className="library-register" onClick={onOpenPluginSettings}><Icon name="plus" size={11} />VST3 등록·관리…</button></li> : null
  const cats = tab === 'instrument' ? [...INSTRUMENT_SECTIONS.map(s => s.title), 'VST3'] : [...EFFECT_SECTIONS.map(s => s.title), 'VST3']
  const cat = tab === 'instrument' ? instCat : fxCat
  const setCat = tab === 'instrument' ? setInstCat : setFxCat
  const rowCount = (tab === 'instrument' ? instruments.length : effects.length) + shownPlugins.length

  return <div className="file-browser lib-panel" aria-label="라이브러리" tabIndex={-1} onKeyDown={keyDown}>
    <div className="lib-tabs" role="tablist" aria-label="라이브러리 종류">
      {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => onTabChange(t.id)} title={t.hint ? `${t.label} · ${t.hint}` : t.label}><span className="lib-tab-label"><Icon name={t.icon} size={13} />{t.label}</span><small>{[t.hint, counts[t.id] || ''].filter(Boolean).join(' · ') || ' '}</small></button>)}
    </div>
    <div className="library-search lib-search"><Icon name="search" size={13} /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'audio' ? '오디오 찾기' : tab === 'effect' ? '시김새 찾기' : '악기 찾기'} aria-label="라이브러리 검색" />{search && <button type="button" className="lib-search-clear" onClick={() => setSearch('')} aria-label="검색어 지우기"><Icon name="close" size={11} /></button>}</div>
    {tab === 'audio' ? <div className="lib-content" role="tabpanel" aria-label="오디오">
      <h4 className="lib-group">프로젝트 오디오<small>{originals.length || ''}</small><button type="button" onClick={onImport} title="오디오·MIDI 가져오기" aria-label="오디오·MIDI 가져오기"><Icon name="plus" size={13} /></button></h4>
      <ul className="lib-list">{audio.map(asset => <li key={asset.id} className="lib-card lib-audio" {...dragProps({ kind: 'asset', assetId: asset.id })}>
        <button type="button" className="lib-card-main" onClick={() => onUse({ kind: 'asset', assetId: asset.id })} title="클릭하여 추가 · 타임라인으로 끌어 원하는 위치에 놓기">
          <span className="lib-audio-head"><Icon name="wave" size={12} /><strong>{asset.name}</strong></span>
          <Waveform peaks={asset.peaks} />
          <small>{asset.buffer.duration.toFixed(1)} s · {asset.buffer.numberOfChannels === 2 ? '스테레오' : '모노'}</small>
        </button>
      </li>)}</ul>
      {!audio.length && <div className="file-browser-empty"><Icon name="folder" size={22} /><p>{originals.length ? '일치하는 파일이 없습니다' : '아직 가져온 오디오가 없습니다'}</p><button type="button" onClick={onImport}><Icon name="upload" size={13} />오디오·MIDI 가져오기</button></div>}
    </div> : <div className={`library-cols ${q ? 'flat' : ''}`} role="tabpanel" aria-label={what}>
      {!q && <ul className="library-cats" role="listbox" aria-label="카테고리">{cats.map((title, i) => <li key={title}><button type="button" role="option" aria-selected={i === cat} className={i === cat ? 'active' : ''} onClick={() => setCat(i)}>{title}<Icon name="right" size={10} /></button></li>)}</ul>}
      <ul className="library-patches" role="listbox" aria-label={what} ref={listRef}>
        {tab === 'instrument' ? instruments.map(instrumentRow) : effects.map(effectRow)}
        {shownPlugins.map(pluginRow)}
        {vstState}
        {!rowCount && !vstOpen && <li className="library-empty">일치하는 {what}가 없습니다</li>}
      </ul>
    </div>}
    <p className="lib-foot"><Icon name="grip" size={11} />{target}</p>
  </div>
}
