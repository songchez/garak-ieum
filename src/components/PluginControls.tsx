import { useEffect, useRef, useState } from 'react'
import type { NativeAudioEngine } from '../audio/native/NativeAudioEngine'
import type { NativePluginDescriptor, NativePluginInstance, NativePluginParameter } from '../audio/native/contracts'
import { Icon } from './Icon'

export type PluginEngine = Pick<NativeAudioEngine, 'pluginEditor' | 'pluginParameters' | 'setPluginParameter' | 'capturePlugin'>

interface Props<T extends NativePluginInstance> {
  engine: PluginEngine
  plugin: T
  trackEnabled: boolean
  /** Recording, rendering or an audio reconfiguration is in progress. */
  locked: boolean
  catalog: readonly NativePluginDescriptor[]
  catalogLoaded: boolean
  onChange(update: (plugin: T) => T, label: string): void
  onOpenPluginSettings?(): void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The body of a VST3 card: its own window, saved state, exposed parameters and reinstall linking. */
export function PluginControls<T extends NativePluginInstance>({ engine, plugin, trackEnabled, locked, catalog, catalogLoaded, onChange, onOpenPluginSettings }: Props<T>) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [paramsOpen, setParamsOpen] = useState(false)
  const [parameters, setParameters] = useState<NativePluginParameter[] | null>(null)
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const installed = catalog.some(item => item.pluginId === plugin.pluginId)
  const replacement = !installed ? catalog.find(item => item.classId.toUpperCase() === plugin.classId.toUpperCase()) : undefined
  const missing = catalogLoaded && !installed
  const active = trackEnabled && plugin.enabled && !missing
  const busy = locked || saving

  useEffect(() => {
    if (!paramsOpen || !active) { setParameters(null); return }
    let canceled = false
    void engine.pluginParameters(plugin.id).then(value => { if (!canceled) setParameters(value.filter(parameter => !parameter.hidden)) },
      error => { if (!canceled) { setParameters([]); setNotice(message(error)) } })
    return () => { canceled = true }
  }, [engine, plugin.id, paramsOpen, active, refresh])

  async function saveState() {
    setSaving(true); setNotice('')
    try {
      const captured = await engine.capturePlugin(plugin, !active)
      if (!alive.current) return
      onChange(() => captured, 'VST3 상태 저장')
      setRefresh(value => value + 1); setNotice('플러그인 상태를 프로젝트에 저장했습니다.')
    } catch (error) { if (alive.current) setNotice(message(error)) }
    finally { if (alive.current) setSaving(false) }
  }

  async function toggleEditor() {
    const opening = !editorOpen
    try {
      await engine.pluginEditor(plugin.id, opening)
      if (!alive.current) return
      setEditorOpen(opening)
      // Closing the plugin's own window is the natural moment to keep what was changed in it.
      if (!opening) await saveState()
    } catch (error) { if (alive.current) setNotice(message(error)) }
  }

  function parameterChanged(parameter: NativePluginParameter, raw: number) {
    if (!Number.isFinite(raw)) return
    const value = Math.max(0, Math.min(1, raw))
    void engine.setPluginParameter(plugin.id, parameter.id, value).catch(error => { if (alive.current) setNotice(message(error)) })
    setParameters(previous => previous?.map(item => item.id === parameter.id ? { ...item, value } : item) ?? null)
    onChange(current => ({ ...current, parameters: { ...current.parameters, [parameter.id]: value } }), `VST3 ${parameter.title}`)
  }

  return <div className="dc-plugin-body">
    {missing ? <div className="dc-plugin-missing" role="status">
      <Icon name="info" size={12}/><span>이 컴퓨터에 설치되지 않은 플러그인입니다.</span>
      {replacement ? <button disabled={busy} onClick={() => { onChange(current => ({ ...current, pluginId: replacement.pluginId, name: replacement.name }), 'VST3 설치본 연결'); setNotice('같은 플러그인의 설치본으로 연결했습니다. 저장한 상태는 유지됩니다.') }}>설치본 연결</button>
        : onOpenPluginSettings && <button onClick={onOpenPluginSettings}>플러그인 등록…</button>}
    </div> : <div className="dc-plugin-actions">
      <button className="dc-plugin-window" disabled={busy || !active} onClick={() => void toggleEditor()} title={active ? undefined : '켜진 트랙과 플러그인에서 창을 열 수 있습니다'}>
        <Icon name="external" size={12}/>{editorOpen ? '창 닫기·저장' : '플러그인 창'}
      </button>
      <button disabled={busy} onClick={() => void saveState()} title="플러그인 창에서 바꾼 소리를 프로젝트에 저장">{saving ? '저장 중…' : '상태 저장'}</button>
    </div>}
    {!missing && <details className="dc-plugin-params" onToggle={event => setParamsOpen(event.currentTarget.open)}>
      <summary>파라미터</summary>
      {!active ? <p className="dc-note">켜면 파라미터를 표시합니다.</p>
        : parameters === null ? <p className="dc-note" role="status">읽는 중…</p>
        : parameters.length === 0 ? <p className="dc-note">공개된 파라미터가 없습니다. 플러그인 창에서 설정하세요.</p>
        : <div className="dc-plugin-param-list">{parameters.map(parameter => <label key={parameter.id}>
          <span title={parameter.title}>{parameter.title}</span>
          <input type="range" min={0} max={1} step={parameter.stepCount > 0 ? 1 / parameter.stepCount : .001} value={parameter.value} disabled={busy || parameter.readOnly}
            onChange={event => parameterChanged(parameter, Number(event.target.value))} aria-label={`${plugin.name} ${parameter.title}`}/>
          <output>{parameter.value.toFixed(2)}{parameter.units ? ` ${parameter.units}` : ''}</output>
        </label>)}</div>}
    </details>}
    {notice && <p className="dc-note dc-plugin-notice" role="status">{notice}</p>}
  </div>
}
