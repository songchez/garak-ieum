import { useState } from 'react'
import { WAVE_MOD_DESTINATIONS, WAVE_SOURCES, WAVE_LIMITS, WAVE_PARAM_DEFINITIONS } from '../definition'
import type { WavetableModRoute, WavetableModSource, WavetableParamId } from '../model'
import { RangeControl } from './controls'

export function sourceName(source: string) {
  if (/^(env|lfo)\d$/.test(source)) return source.toUpperCase().replace(/(\d)/, ' $1')
  if (source.startsWith('macro')) return `MACRO ${source.slice(5)}`
  return ({ velocity: '연주 강도', key: '음 높이', random: '노트 랜덤' } as Record<string, string>)[source] ?? source
}
export function destinationName(id: string) {
  const def = WAVE_PARAM_DEFINITIONS.find(item => item.id === id)
  if (!def) return id
  const prefix = id.match(/^(osc|filter|env|lfo)(\d)/)
  const group = prefix ? `${({ osc: 'OSC', filter: 'FILTER', env: 'ENV', lfo: 'LFO' } as Record<string, string>)[prefix[1]]} ${prefix[2]}` : ''
  return [group, def.label].filter(Boolean).join(' · ')
}
function SourceOptions({ includeNone = false }: { includeNone?: boolean }) {
  return <>{includeNone && <option value="">없음</option>}{WAVE_SOURCES.map(source => <option value={source.id} key={source.id}>{sourceName(source.id)}</option>)}</>
}
function DestinationOptions() {
  return <>{WAVE_MOD_DESTINATIONS.map(def => <option value={def.id} key={def.id}>{destinationName(def.id)}</option>)}</>
}

export function ModulationMatrix({ routes, onUpdate, onRemove, onAdd, selectedDestination }: { routes: readonly WavetableModRoute[]; onUpdate: (id: string, patch: Partial<WavetableModRoute>) => void; onRemove: (id: string) => void; onAdd: (source: WavetableModSource, destination: WavetableParamId) => void; selectedDestination?: string | null }) {
  const [source, setSource] = useState<WavetableModSource>('lfo1'), [destination, setDestination] = useState<WavetableParamId>('filter1Cutoff')
  const filtered = selectedDestination ? routes.filter(route => route.destination === selectedDestination) : routes
  return <section className="iw-matrix" aria-label="변조 매트릭스">
    <div className="iw-section-heading"><div><span className="iw-eyebrow">MODULATION MATRIX</span><h3>{selectedDestination ? destinationName(selectedDestination) : '움직임을 연결하세요'}</h3></div><span className="iw-count">{routes.length} / {WAVE_LIMITS.routes}</span></div>
    <div className="iw-route-add"><label><span>소스</span><select aria-label="새 변조 소스" value={source} onChange={event => setSource(event.target.value as WavetableModSource)}><SourceOptions/></select></label><span className="iw-route-arrow" aria-hidden="true">→</span><label><span>대상</span><select aria-label="새 변조 대상" value={selectedDestination ?? destination} disabled={!!selectedDestination} onChange={event => setDestination(event.target.value as WavetableParamId)}><DestinationOptions/></select></label><button className="iw-button iw-button-accent" disabled={routes.length >= WAVE_LIMITS.routes} onClick={() => onAdd(source, (selectedDestination ?? destination) as WavetableParamId)}>+ 연결 추가</button></div>
    {filtered.length === 0 ? <div className="iw-matrix-empty"><span aria-hidden="true">↗</span><strong>아직 연결된 변조가 없습니다</strong><p>LFO나 ENV의 이름을 노브로 끌어 놓으세요.<br/>위에서 소스와 대상을 선택해 연결할 수도 있습니다.</p></div> : <div className="iw-matrix-list" role="list" aria-label="변조 연결 목록">{filtered.map((route, index) => <article className={`iw-route${route.enabled ? '' : ' is-bypassed'}`} role="listitem" key={route.id} data-route-id={route.id}>
      <div className="iw-route-main"><button className={`iw-route-enable${route.enabled ? ' is-on' : ''}`} aria-pressed={route.enabled} aria-label={`${sourceName(route.source)} → ${destinationName(route.destination)} 연결 켜기/끄기`} onClick={() => onUpdate(route.id, { enabled: !route.enabled })}>{String(index + 1).padStart(2, '0')}</button>
        <select aria-label={`${index + 1}번 변조 소스`} value={route.source} onChange={event => onUpdate(route.id, { source: event.target.value as WavetableModSource })}><SourceOptions/></select><span className="iw-route-arrow" aria-hidden="true">→</span><select aria-label={`${index + 1}번 변조 대상`} value={route.destination} onChange={event => onUpdate(route.id, { destination: event.target.value as WavetableParamId })}><DestinationOptions/></select>
        <button className="iw-route-remove" onClick={() => onRemove(route.id)} aria-label={`${index + 1}번 변조 연결 삭제`} title="연결 삭제">×</button>
      </div>
      <div className="iw-route-controls"><RangeControl label={`${sourceName(route.source)} 변조량`} value={route.amount} min={-1} max={1} step={.001} valueText={`${route.amount > 0 ? '+' : ''}${Math.round(route.amount * 100)}%`} onChange={amount => onUpdate(route.id, { amount })}/><button className={`iw-polarity${route.bipolar ? ' is-on' : ''}`} aria-pressed={route.bipolar} aria-label={`${index + 1}번 양방향 변조`} onClick={() => onUpdate(route.id, { bipolar: !route.bipolar })}>{route.bipolar ? '↔ 양방향' : '→ 단방향'}</button><label className="iw-route-aux"><span>AUX</span><select aria-label={`${index + 1}번 보조 변조 소스`} value={route.aux ?? ''} onChange={event => onUpdate(route.id, { aux: event.target.value ? event.target.value as WavetableModSource : null })}><SourceOptions includeNone/></select></label><RangeControl label={`${index + 1}번 반응 곡선`} value={route.curve} min={-1} max={1} step={.01} valueText={route.curve === 0 ? '선형' : `${route.curve > 0 ? '+' : ''}${route.curve.toFixed(2)}`} onChange={curve => onUpdate(route.id, { curve })}/></div>
    </article>)}</div>}
    <p className="iw-caption">양방향은 노브의 기준값을 중심으로 움직입니다. AUX는 변조량을 조절하는 보조 소스입니다.</p>
  </section>
}
