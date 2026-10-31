// Dev-only visual harness: `await import('/src/dev/inspectorHarness.tsx')` in the browser console mounts
// Library + Inspector + Browser + NewTracksDialog over the app with demo data and a silent fake engine.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AudioAsset, AudioEngine, Clip, InstrumentId, Project, Track } from '../core/types'
import { createDemoProject, createDevice, createTrack, moveDevice } from '../core/project'
import { effectiveArm, implicitlyMuted, pressTrackButton, sweepTrackButton } from '../core/trackActions'
import type { InspectorSections } from '../core/trackUi'
import { Inspector, type ClipEntry } from '../components/Inspector'
import { Library } from '../components/Library'
import { Browser } from '../components/Browser'
import { NewTracksDialog } from '../components/NewTracksDialog'
import '../styles.css'

const noop = () => {}
const fakeEngine: AudioEngine = {
  kind: 'web-audio',
  setProject: noop, setAssets: noop, resume: async () => {}, play: async () => {}, pause: noop, stop: noop, seek: noop,
  previewNote: async () => {}, decodeAsset: () => Promise.reject(new Error('fake')), exportWav: () => Promise.reject(new Error('fake')),
  subscribe: () => noop, getSnapshot: () => ({ playing: false, beat: 0, ready: true, sampleRate: 48000 }),
  sampleStatus: () => 'ready', preloadSamples: async () => {}, subscribeSamples: () => noop, sampleAttribution: () => undefined,
  getTrackLevel: () => .25 + .2 * Math.abs(Math.sin(performance.now() / 300)), getMasterLevel: () => .4 + .2 * Math.abs(Math.sin(performance.now() / 500)),
  setInputMonitor: noop, dispose: noop,
}

function Harness() {
  const [project, setProject] = useState<Project>(() => { const p = createDemoProject(); p.tracks[2].devices = [createDevice('eq'), createDevice('reverb', { amount: .4 }), createDevice('compressor')]; p.tracks[2].devices[1].enabled = false; const audio = createTrack('audio'); audio.name = 'Vocal'; p.tracks.push(audio); const second = p.tracks[2].clips[1]; if (second?.kind === 'midi') { second.transpose = 3; second.mute = true; second.quantize = .25 } return p })
  const [focusedId, setFocusedId] = useState(project.tracks[2].id)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(() => new Set(project.tracks[2].clips.slice(0, 2).map(c => c.id)))
  const [sections, setSections] = useState<InspectorSections>({ region: true, track: true, strips: true })
  const [dialog, setDialog] = useState(new URLSearchParams(location.search).get('dialog') === '1')
  const [log, setLog] = useState<string[]>([])
  const say = (s: string) => setLog(l => [s, ...l].slice(0, 8))
  const focused = project.tracks.find(t => t.id === focusedId)
  const selection: ClipEntry[] = project.tracks.flatMap(t => t.clips.filter(c => selectedClipIds.has(c.id)).map(clip => ({ trackId: t.id, clip })))
  const edit = (fn: (p: Project) => Project) => setProject(fn)
  const editTrack = (id: string, fn: (t: Track) => Track) => edit(p => ({ ...p, tracks: p.tracks.map(t => t.id === id ? fn(t) : t) }))
  return <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--ink-09)', zIndex: 1000 }}>
    <Library focusedTrack={focused} engine={fakeEngine} onSelectPatch={id => { if (focused) editTrack(focused.id, t => ({ ...t, instrument: id })); say(`patch ${id}`) }} onPreview={id => say(`preview ${id}`)} onAddTrack={id => say(`add track ${id}`)} />
    <Inspector project={project} focusedTrack={focused} selection={selection} engine={fakeEngine} recording={false} arm={focused ? effectiveArm(focused, focusedId, project.tracks) : 'off'} implicitMute={focused ? implicitlyMuted(focused, project) : false}
      sections={sections} onSectionsChange={setSections}
      onClipsEdit={(fn: (c: Clip) => Clip) => edit(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(c => selectedClipIds.has(c.id) ? fn(c) : c) })) }))}
      onTrackChange={(id, patch) => editTrack(id, t => ({ ...t, ...patch }))}
      onTrackButton={(id, kind, mods) => edit(p => pressTrackButton(p, id, kind, mods))} onTrackSweep={(id, kind, v) => edit(p => sweepTrackButton(p, id, kind, v))}
      onInstrumentChange={(id, instrument: InstrumentId) => editTrack(id, t => ({ ...t, instrument }))}
      onAddDevice={(id, type) => editTrack(id, t => ({ ...t, devices: [...t.devices, createDevice(type)] }))}
      onToggleDevice={(id, deviceId) => editTrack(id, t => ({ ...t, devices: t.devices.map(d => d.id === deviceId ? { ...d, enabled: !d.enabled } : d) }))}
      onMoveDevice={(id, deviceId, offset) => editTrack(id, t => moveDevice(t, deviceId, offset))}
      onRemoveDevice={(id, deviceId) => editTrack(id, t => ({ ...t, devices: t.devices.filter(d => d.id !== deviceId) }))}
      onOpenDevices={(id, deviceId) => say(`open devices ${id} ${deviceId ?? ''}`)}
      onMasterChange={masterVolume => edit(p => ({ ...p, masterVolume }))}
      onOpenColorPalette={id => say(`palette ${id}`)} onIconMenu={id => say(`icon menu ${id}`)} />
    <div style={{ flex: 1, padding: 16, color: 'var(--ink-66)', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{project.tracks.map(t => <button key={t.id} style={{ border: `1px solid ${t.id === focusedId ? t.color : 'var(--ink-25)'}`, padding: '4px 8px', borderRadius: 4 }} onClick={() => { setFocusedId(t.id); setSelectedClipIds(new Set(t.clips.slice(0, 1).map(c => c.id))) }}>{t.name}</button>)}
        <button style={{ border: '1px solid var(--ink-25)', padding: '4px 8px', borderRadius: 4 }} onClick={() => setSelectedClipIds(new Set())}>선택 해제</button>
        <button style={{ border: '1px solid var(--ink-25)', padding: '4px 8px', borderRadius: 4 }} onClick={() => setDialog(true)}>새 트랙 창</button></div>
      <pre style={{ margin: 0, fontSize: 10, color: 'var(--ink-54)' }}>{log.join('\n')}</pre>
      <pre style={{ margin: 0, fontSize: 9, color: 'var(--ink-42)', overflow: 'auto' }}>{JSON.stringify(selection.map(e => { const { notes: _n, ...rest } = e.clip as Clip & { notes?: unknown }; return rest }), null, 1)}</pre>
    </div>
    <Browser assets={new Map<string, AudioAsset>()} onAddAsset={a => say(`add asset ${a.name}`)} onImport={() => say('import')} />
    {dialog && <NewTracksDialog focusedKind={focused?.kind} focusedInstrument={focused?.instrument} onCreate={opts => { say(`create ${JSON.stringify(opts)}`); setDialog(false) }} onClose={() => setDialog(false)} />}
  </div>
}

// Vite may evaluate this module more than once (dep discovery / HMR): keep a single mount.
document.getElementById('inspector-harness')?.remove()
const host = document.createElement('div')
host.id = 'inspector-harness'
document.body.appendChild(host)
createRoot(host).render(<StrictMode><Harness /></StrictMode>)
