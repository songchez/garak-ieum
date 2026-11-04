import { useEffect, useRef, useState } from 'react'
import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import type { NativePluginDescriptor, NativePluginInstance, NativePluginParameter } from '../audio/native/contracts'
import { uid } from '../core/project'
import type { Track } from '../core/types'
import { Icon } from './Icon'
import './NativePluginsPanel.css'

interface Props {
  engine: NativeAudioEngine
  track: Track
  disabled: boolean
  onChange(patch: Partial<Track>, label: string): void
}
const key = (plugin: NativePluginDescriptor) => `${plugin.pluginId}:${plugin.classId}`
const instance = (plugin: NativePluginDescriptor): NativePluginInstance => ({
  id: uid(), pluginId: plugin.pluginId, classId: plugin.classId.toUpperCase(), name: plugin.name, enabled: true, parameters: {},
})

/** Catalog paths stay in Electron. This panel edits only approved IDs and serializable state. */
export default function NativePluginsPanel({ engine, track, disabled, onChange }: Props) {
  const [catalog, setCatalog] = useState<NativePluginDescriptor[]>([])
  const [chosen, setChosen] = useState('')
  const [selectedId, setSelectedId] = useState(track.pluginInstrument?.id ?? track.pluginInserts?.[0]?.id ?? '')
  const [parameters, setParameters] = useState<NativePluginParameter[]>([])
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  const items = [...(track.pluginInstrument ? [track.pluginInstrument] : []), ...(track.pluginInserts ?? [])]
  const selected = items.find(plugin => plugin.id === selectedId)
  const replacement = catalog.find(plugin => key(plugin) === chosen && plugin.classId.toUpperCase() === selected?.classId.toUpperCase())
  const locked = disabled || scanning || saving
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let canceled = false
    void engine.listPlugins().then(value => { if (!canceled) setCatalog(value) }, error => { if (!canceled) setMessage(error instanceof Error ? error.message : String(error)) })
    return () => { canceled = true }
  }, [engine])
  useEffect(() => {
    if (selectedId && items.some(plugin => plugin.id === selectedId)) return
    setSelectedId(items[0]?.id ?? ''); setEditorOpen(false)
  }, [selectedId, track.pluginInstrument, track.pluginInserts])
  useEffect(() => {
    let canceled = false
    setParameters([])
    if (!selected || !selected.enabled || !track.enabled) { setLoading(false); return }
    setLoading(true)
    void engine.pluginParameters(selected.id).then(value => { if (!canceled) setParameters(value.filter(parameter => !parameter.hidden)) }, error => { if (!canceled) setMessage(error instanceof Error ? error.message : String(error)) }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [engine, selectedId, selected?.enabled, track.enabled, refresh])

  function changeInstance(id: string, update: (value: NativePluginInstance) => NativePluginInstance, label: string) {
    if (track.pluginInstrument?.id === id) onChange({ pluginInstrument: update(track.pluginInstrument) }, label)
    else onChange({ pluginInserts: (track.pluginInserts ?? []).map(value => value.id === id ? update(value) : value) }, label)
  }

  async function scan() {
    setScanning(true); setMessage('')
    try {
      const added = await engine.scanPlugins()
      if (!alive.current) return
      setCatalog(previous => [...new Map([...previous, ...added].map(plugin => [key(plugin), plugin])).values()])
      if (added[0]) setChosen(key(added[0]))
      if (added.length) setMessage(`${added.length}개 VST3 플러그인을 확인했습니다.`)
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (alive.current) setScanning(false) }
  }

  function add() {
    const plugin = catalog.find(value => key(value) === chosen)
    if (!plugin || locked) return
    if (plugin.isInstrument && track.kind !== 'instrument') { setMessage('VST3 악기는 악기 트랙에 추가해 주세요.'); return }
    if (!plugin.isInstrument && (track.pluginInserts?.length ?? 0) + track.devices.length >= 64) { setMessage('한 트랙에는 최대 64개 인서트를 사용할 수 있습니다.'); return }
    const added = instance(plugin)
    if (plugin.isInstrument) onChange({ pluginInstrument: added }, 'VST3 악기 변경')
    else onChange({ pluginInserts: [...(track.pluginInserts ?? []), added] }, 'VST3 이펙트 추가')
    setSelectedId(added.id); setMessage(''); setEditorOpen(false)
  }

  async function editor() {
    if (!selected) return
    const opening = !editorOpen
    try {
      await engine.pluginEditor(selected.id, opening)
      if (alive.current) setEditorOpen(opening)
      if (!opening) await saveState()
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)) }
  }

  async function saveState() {
    if (!selected) return
    setSaving(true); setMessage('')
    try {
      const captured = await engine.capturePlugin(selected, !track.enabled || !selected.enabled)
      if (!alive.current) return
      changeInstance(selected.id, () => captured, 'VST3 상태 저장')
      setRefresh(value => value + 1); setMessage('플러그인 상태를 프로젝트에 반영했습니다.')
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (alive.current) setSaving(false) }
  }

  function remove() {
    if (!selected) return
    void engine.pluginEditor(selected.id, false).catch(() => undefined)
    if (selected.id === track.pluginInstrument?.id) onChange({ pluginInstrument: undefined }, 'VST3 악기 제거')
    else onChange({ pluginInserts: (track.pluginInserts ?? []).filter(value => value.id !== selected.id) }, 'VST3 이펙트 제거')
    setEditorOpen(false); setMessage('')
  }

  function move(offset: number) {
    const inserts = [...(track.pluginInserts ?? [])]
    const from = inserts.findIndex(value => value.id === selectedId), to = from + offset
    if (from < 0 || to < 0 || to >= inserts.length) return
    const [plugin] = inserts.splice(from, 1); inserts.splice(to, 0, plugin)
    onChange({ pluginInserts: inserts }, 'VST3 처리 순서 변경')
  }

  function relink() {
    if (!selected || !replacement || locked) return
    changeInstance(selected.id, value => ({ ...value, pluginId: replacement.pluginId, name: replacement.name }), 'VST3 설치본 연결')
    setRefresh(value => value + 1); setMessage('같은 VST3 클래스의 설치본으로 연결했습니다. 저장한 상태와 파라미터는 유지됩니다.')
  }

  function parameterChanged(parameter: NativePluginParameter, value: number) {
    if (!selected || !Number.isFinite(value)) return
    const normalized = Math.max(0, Math.min(1, value))
    void engine.setPluginParameter(selected.id, parameter.id, normalized).catch(error => { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)) })
    setParameters(previous => previous.map(item => item.id === parameter.id ? { ...item, value: normalized } : item))
    changeInstance(selected.id, plugin => ({ ...plugin, parameters: { ...plugin.parameters, [parameter.id]: normalized } }), `VST3 ${parameter.title}`)
  }

  return <section className="native-plugins-panel" aria-label="VST3 플러그인" data-keyboard-scope="devices" tabIndex={-1}>
    <header><div><Icon name="plug" size={17}/><strong>VST3</strong><span>네이티브 악기·이펙트</span></div><button disabled={locked} onClick={() => void scan()}>{scanning ? '플러그인 확인 중…' : 'VST3 파일 추가…'}</button></header>
    <div className="native-plugin-add"><select aria-label="설치된 VST3 플러그인" value={chosen} disabled={locked} onChange={event => setChosen(event.target.value)}><option value="">등록된 플러그인 선택</option>{catalog.filter(plugin => !plugin.isInstrument || track.kind === 'instrument').map(plugin => <option key={key(plugin)} value={key(plugin)}>{plugin.name} · {plugin.isInstrument ? '악기' : '이펙트'}{plugin.vendor ? ` · ${plugin.vendor}` : ''}</option>)}</select><button disabled={locked || !chosen} onClick={add}>트랙에 추가</button></div>
    <p className="native-plugin-hint">악기 슬롯과 내장 효과 다음의 VST3 인서트 순서입니다. 다른 컴퓨터에서 연 프로젝트는 설치된 플러그인을 등록하고 같은 플러그인의 설치본을 연결해 주세요.</p>
    {selected && <button disabled={locked || !replacement || replacement.pluginId === selected.pluginId} onClick={relink}>선택한 설치본으로 연결</button>}
    {items.length > 0 && <>
      <div className="native-plugin-chain" role="list" aria-label="VST3 처리 순서">{items.map(plugin => <button role="listitem" key={plugin.id} className={selectedId === plugin.id ? 'active' : ''} aria-pressed={selectedId === plugin.id} onClick={() => { setSelectedId(plugin.id); setEditorOpen(false); setMessage('') }}><small>{plugin.id === track.pluginInstrument?.id ? '악기' : `인서트 ${(track.pluginInserts?.findIndex(item => item.id === plugin.id) ?? 0) + 1}`}</small><span>{plugin.name}</span>{!plugin.enabled && <small>바이패스</small>}</button>)}</div>
      {selected && <div className="native-plugin-editor">
        <div className="native-plugin-toolbar"><strong>{selected.name}</strong><label><input type="checkbox" checked={selected.enabled} disabled={locked} onChange={event => changeInstance(selected.id, value => ({ ...value, enabled: event.target.checked }), 'VST3 켬/끔')}/>사용</label><button disabled={locked || loading || !track.enabled || !selected.enabled} onClick={() => void editor()}>{editorOpen ? '플러그인 창 닫기·저장' : '플러그인 창 열기'}</button><button disabled={locked || loading} onClick={() => void saveState()}>{saving ? '저장 중…' : '중지하고 상태 저장'}</button><button disabled={locked} onClick={() => setRefresh(value => value + 1)}>파라미터 새로고침</button>{selected.id !== track.pluginInstrument?.id && <><button disabled={locked || track.pluginInserts?.[0]?.id === selected.id} onClick={() => move(-1)} aria-label="VST3 인서트 앞으로 이동">←</button><button disabled={locked || track.pluginInserts?.at(-1)?.id === selected.id} onClick={() => move(1)} aria-label="VST3 인서트 뒤로 이동">→</button></>}<button disabled={locked} onClick={remove}>제거</button></div>
        {loading ? <p role="status">플러그인 파라미터를 읽는 중…</p> : <div className="native-plugin-parameters">{parameters.map(parameter => <label key={parameter.id}><span>{parameter.title}</span><input type="range" min={0} max={1} step={parameter.stepCount > 0 ? 1 / parameter.stepCount : .001} value={parameter.value} disabled={locked || parameter.readOnly} onChange={event => parameterChanged(parameter, Number(event.target.value))} aria-label={`${selected.name} ${parameter.title}`}/><output>{parameter.value.toFixed(3)}{parameter.units ? ` ${parameter.units}` : ''}</output></label>)}</div>}
        {!loading && parameters.length === 0 && <p className="native-plugin-hint">{!track.enabled || !selected.enabled ? '사용을 켜면 플러그인의 파라미터를 표시합니다.' : '공개된 파라미터가 없습니다. 제공되는 경우 플러그인 자체 창에서 설정할 수 있습니다.'}</p>}
      </div>}
    </>}
    {message && <p className="native-plugin-message" role="status">{message}</p>}
  </section>
}
