/**
 * Dev-only showcase for the track header components. Self-mounts over the app when imported, e.g. from the CDP script:
 *   await import('/src/dev/harness.tsx')
 * Not imported by the app; safe to delete.
 */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AudioEngine, Track } from '../core/types'
import { DEFAULT_HEADER_CONFIG, type TrackHeaderConfig } from '../core/trackUi'
import { TrackHeader, type TrackHeaderProps } from '../components/TrackHeader'
import { TrackButtons } from '../components/TrackButtons'
import { VolumeSlider } from '../components/VolumeSlider'
import { PanKnob } from '../components/PanKnob'
import { ColorPalette } from '../components/ColorPalette'
import { HeaderConfigPopover } from '../components/HeaderConfigPopover'

const levels = new Map<string, number>()
const fakeEngine = {
  kind: 'web-audio',
  getTrackLevel: (id: string) => { const v = Math.max(0, (levels.get(id) ?? .2) + (Math.random() - .5) * .15); levels.set(id, Math.min(.95, v)); return v },
  getMasterLevel: () => .4,
  subscribeSamples: () => () => {},
  sampleStatus: () => 'ready',
} as unknown as AudioEngine

const base = (over: Partial<Track>): Track => ({
  id: 't', name: '트랙', kind: 'instrument', instrument: 'keys', color: '#7fb59a', volume: 1, pan: 0, mute: false, solo: false, soloSafe: false, enabled: true, armed: false, monitor: false, hidden: false,
  transpose: 0, velocityOffset: 0, keyLimit: [0, 127], velocityLimit: [1, 127], delayTicks: 0, clips: [], instrumentParams: {}, devices: [], ...over,
})

const TRACKS: Track[] = [
  base({ id: 'a', name: '벨벳 키', instrument: 'keys', color: '#6f9fd0' }),
  base({ id: 'b', name: '포켓 드럼 (솔로)', instrument: 'drums', color: '#e38457', solo: true }),
  base({ id: 'c', name: '보컬 테이크 — 이름이 꽤 길어서 잘립니다', kind: 'audio', instrument: 'keys', color: '#8cc7c0', volume: .7, pan: -.4, armed: true, monitor: true }),
  base({ id: 'd', name: '가야금 (Solo Safe)', instrument: 'gayageum', color: '#c9a06a', soloSafe: true, pan: .5, volume: 1.3 }),
  base({ id: 'e', name: '꺼진 패드', instrument: 'pad', color: '#d98a9f', enabled: false, mute: true }),
  base({ id: 'f', name: '숨긴 베이스', instrument: 'bass', color: '#7fb59a', hidden: true }),
]

const noop = () => {}
const stubs: Pick<TrackHeaderProps, 'onClick' | 'onFocus' | 'onButton' | 'onSweep' | 'onChange' | 'onRename' | 'onOpenLibrary' | 'onIconMenu' | 'onContextMenu' | 'onReorderStart' | 'onResizeStart'> = {
  onClick: m => console.log('click', m), onFocus: noop, onButton: (id, kind, mods) => console.log('button', id, kind, mods), onSweep: (id, kind, v) => console.log('sweep', id, kind, v),
  onChange: (patch, key) => console.log('change', patch, key), onRename: name => console.log('rename', name), onOpenLibrary: () => console.log('library'), onIconMenu: e => { e.preventDefault(); console.log('icon menu') },
  onContextMenu: e => { e.preventDefault(); console.log('context menu') }, onReorderStart: noop, onResizeStart: (_, all, reset) => console.log('resize', { all, reset }),
}

function Column({ width, height, config, hideView, recording, label }: { width: number; height: number; config: TrackHeaderConfig; hideView: boolean; recording: boolean; label: string }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
    <div style={{ fontSize: 8, color: 'var(--ink-48)', letterSpacing: 1, margin: '0 0 4px' }}>{label}</div>
    <div style={{ width, border: '1px solid var(--ink-23)', background: 'var(--ink-11)', '--header-width': `${width}px` } as React.CSSProperties}>
      {TRACKS.map((track, i) => <div key={track.id} className="track-row" style={{ height, '--row-h': `${height}px`, width } as React.CSSProperties}>
        <TrackHeader {...stubs} track={track} index={i} focused={i === 1} selected={i === 1 || i === 2} multi height={height} config={config} ui={{ hideView, recording }} arm={track.armed ? 'armed' : i === 0 ? 'auto' : 'off'} implicitMute={!track.solo && !track.soloSafe && track.enabled && !track.mute} renaming={false} engine={fakeEngine}/>
      </div>)}
    </div>
  </div>
}

function Harness() {
  const [config, setConfig] = useState<TrackHeaderConfig>({ ...DEFAULT_HEADER_CONFIG, onOff: true, hide: true, colorBar: true })
  const [palette, setPalette] = useState(true)
  const [cfg, setCfg] = useState(true)
  const [vol, setVol] = useState(.8)
  const [pan, setPan] = useState(.3)
  const [color, setColor] = useState('#6f9fd0')
  return <div style={{ position: 'fixed', inset: 0, zIndex: 100, overflow: 'auto', padding: 16, background: 'var(--ink-10)', color: 'var(--ink-87)', display: 'flex', gap: 18, alignItems: 'flex-start' }}>
    <Column label="H 40 · W 248 (tier 0)" width={248} height={40} config={config} hideView recording={false}/>
    <Column label="H 70 · W 248 (tier 1)" width={248} height={70} config={config} hideView={false} recording/>
    <Column label="H 120 · W 248 (tier 3)" width={248} height={120} config={config} hideView recording={false}/>
    <Column label="H 80 · W 208 (tier 2, 너비<230 → 슬라이더 숨김)" width={208} height={80} config={DEFAULT_HEADER_CONFIG} hideView={false} recording={false}/>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 160 }}>
      <div style={{ fontSize: 8, color: 'var(--ink-48)', letterSpacing: 1 }}>STRIP SIZE</div>
      <TrackButtons track={TRACKS[2]} kinds={['mute', 'solo', 'arm', 'monitor']} arm="armed" recording={false} implicitMute={false} size="strip" onPress={stubs.onButton} onSweep={stubs.onSweep}/>
      <div style={{ display: 'flex', gap: 14, height: 160 }}>
        <VolumeSlider value={vol} orientation="vertical" meter={{ engine: fakeEngine, trackId: 'a' }} onChange={v => setVol(v)}/>
        <PanKnob value={pan} size={34} onChange={v => setPan(v)}/>
      </div>
      <div style={{ width: 150 }}><VolumeSlider value={vol} orientation="horizontal" meter={{ engine: fakeEngine, trackId: 'b' }} onChange={v => setVol(v)}/></div>
      <button type="button" onClick={() => setPalette(true)} style={{ border: '1px solid var(--ink-25)', padding: 4 }}>팔레트</button>
      <button type="button" onClick={() => setCfg(true)} style={{ border: '1px solid var(--ink-25)', padding: 4 }}>헤더 구성</button>
      <div style={{ fontSize: 9, color: 'var(--ink-60)' }}>color {color}</div>
    </div>
    {palette && <ColorPalette x={1040} y={60} value={color} onPick={(hex, trackOnly) => { setColor(hex); console.log('pick', hex, trackOnly) }} onClose={() => setPalette(false)}/>}
    {cfg && <HeaderConfigPopover x={1040} y={200} config={config} onChange={setConfig} onClose={() => setCfg(false)}/>}
  </div>
}

if (!document.getElementById('header-harness')) {
  const host = document.createElement('div')
  host.id = 'header-harness'
  document.body.appendChild(host)
  createRoot(host).render(<StrictMode><Harness/></StrictMode>)
}
