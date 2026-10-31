// Dev-only visual harness: `await import('/src/dev/timelineHarness.tsx')` mounts the Timeline alone with demo data,
// a fake ticking engine and local state for the §3.1 props. Not imported by the app; safe to delete.
// Query flags: ?play=1 ticks the playhead · ?global=1 shows the marker row · ?hide=1 hide view on.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AudioAsset, AudioEngine, Project, Track } from '../core/types'
import { addMarker, applyDragMode, createDemoProject, createMarker, createTrack, cycleClipIds, deleteMarker, duplicateTrack, duplicateTrackSettings, insertTracks, moveMarker, renameMarker, trimClipStart, trimClipEnd } from '../core/project'
import { clearRecallSolo, pressTrackButton, sweepTrackButton } from '../core/trackActions'
import { DEFAULT_HEADER_CONFIG, DEFAULT_HEADER_WIDTH } from '../core/trackUi'
import { Timeline, type TimelineProps, type TimelineUi } from '../components/Timeline'
import '../styles.css'

const params = new URLSearchParams(location.search)
const noop = () => {}
let beat = 6, playing = params.get('play') === '1', last = performance.now()
const fakeEngine: AudioEngine = {
  kind: 'web-audio',
  setProject: noop, setAssets: noop, resume: async () => {}, play: async () => { playing = true }, pause: () => { playing = false }, stop: () => { playing = false; beat = 0 }, seek: b => { beat = b },
  previewNote: async () => {}, decodeAsset: () => Promise.reject(new Error('fake')), exportWav: () => Promise.reject(new Error('fake')),
  subscribe: () => noop,
  getSnapshot: () => { const now = performance.now(); if (playing) beat = (beat + (now - last) / 500) % 40; last = now; return { playing, beat, ready: true, sampleRate: 48000 } },
  sampleStatus: () => 'ready', preloadSamples: async () => {}, subscribeSamples: () => noop, sampleAttribution: () => undefined,
  getTrackLevel: id => .2 + .3 * Math.abs(Math.sin(performance.now() / 300 + id.length)), getMasterLevel: () => .4,
  setInputMonitor: noop, dispose: noop,
}

function demo(): Project {
  let p = createDemoProject()
  const audio = createTrack('audio'); audio.name = 'Vocal (hidden)'; audio.hidden = true
  p.tracks.push(audio)
  const off = createTrack('instrument', 'pad'); off.name = 'Pad (off)'; off.enabled = false
  off.clips.push({ ...p.tracks[0].clips[0], id: 'off-clip', name: 'Pad swell', startBeat: 4, lengthBeats: 8 })
  p.tracks.push(off)
  const c = p.tracks[2].clips
  if (c[0]?.kind === 'midi') { c[0].loop = true; c[0].lengthBeats = 4; c[0].transpose = 5 }
  if (c[1]) c[1].mute = true
  p.tracks[1].solo = true
  p = addMarker(p, createMarker(0, 'Intro'))
  p = addMarker(p, createMarker(16, 'Verse'))
  return p
}

type Ui = TimelineUi
function Harness() {
  const [project, setProject] = useState<Project>(demo)
  const [focusedTrackId, setFocused] = useState(project.tracks[2].id)
  const [selectedTrackIds, setSelectedTracks] = useState<Set<string>>(() => new Set([project.tracks[2].id]))
  const [selectedClipIds, setSelectedClips] = useState<Set<string>>(() => new Set([project.tracks[2].clips[0].id]))
  const [anchorClipId, setAnchor] = useState<string | null>(project.tracks[2].clips[0].id)
  const [ui, setUi] = useState<Ui>({ headerWidth: DEFAULT_HEADER_WIDTH, headerConfig: DEFAULT_HEADER_CONFIG, hideView: params.get('hide') === '1', recording: false, catch: true, scrollInPlay: false, snap: { on: true, mode: 'smart', relative: false }, dragMode: 'noOverlap', globalTracks: params.get('global') === '1', gridLines: true, trackZoom: {}, zoomFocused: false, soloRecall: null, renamingTrackId: null })
  const [zoom, setZoom] = useState({ ppb: 28, rowHeight: 76 })
  const [log, setLog] = useState<string[]>([])
  const say = (s: string) => { setLog(l => [s, ...l].slice(0, 10)); console.log('[harness]', s) }
  const edit = (fn: (p: Project) => Project) => setProject(fn)
  const track = (id: string) => project.tracks.find(t => t.id === id)
  const selectTracks = (ids: Set<string>, focus: string) => { setSelectedTracks(ids); setFocused(focus) }
  const visible = project.tracks.filter(t => ui.hideView || !t.hidden)

  const props: TimelineProps = {
    project, assets: new Map<string, AudioAsset>(), engine: fakeEngine, focusedTrackId, selectedTrackIds, selectedClipIds, anchorClipId, ui, zoom,
    onUiChange: patch => { setUi(u => ({ ...u, ...patch })); say(`ui ${JSON.stringify(patch).slice(0, 80)}`) },
    onZoomChange: patch => setZoom(z => ({ ...z, ...patch })),
    onTrackClick: (id, mods) => {
      say(`trackClick ${track(id)?.name} ${JSON.stringify(mods)}`)
      const t = track(id); if (!t) return
      if (mods.trackOnly) { selectTracks(new Set([id]), id); return }
      if (mods.toggle) { const next = new Set(selectedTrackIds); if (next.has(id)) next.delete(id); else next.add(id); const clips = new Set(selectedClipIds); for (const c of cycleClipIds(t, project.loop)) next.has(id) ? clips.add(c) : clips.delete(c); setSelectedClips(clips); selectTracks(next, next.has(id) ? id : [...next][0] ?? id); return }
      if (mods.range) { const a = visible.findIndex(x => x.id === focusedTrackId), b = visible.findIndex(x => x.id === id); const [lo, hi] = [Math.min(a, b), Math.max(a, b)]; const ids = visible.slice(lo, hi + 1); setSelectedTracks(new Set(ids.map(x => x.id))); setSelectedClips(new Set(ids.flatMap(x => cycleClipIds(x, project.loop)))); return }
      selectTracks(new Set([id]), id); const clips = cycleClipIds(t, project.loop); setSelectedClips(new Set(clips)); setAnchor(clips[0] ?? null)
    },
    onTrackFocus: id => setFocused(id),
    onTrackButton: (id, kind, mods) => edit(p => pressTrackButton(p, id, kind, mods)),
    onTrackSweep: (id, kind, v) => edit(p => sweepTrackButton(p, id, kind, v)),
    onTracksChange: (patches, key) => { edit(p => ({ ...p, tracks: p.tracks.map(t => { const m = patches.find(x => x.id === t.id); return m ? { ...t, ...m.patch } : t }) })); if (key) say(`change ${key}`) },
    onTracksReorder: (ids, afterId) => { say(`reorder [${ids.map(i => track(i)?.name).join(', ')}] after ${afterId ? track(afterId)?.name : 'top'}`); edit(p => { const moving = p.tracks.filter(t => ids.includes(t.id)); const rest = p.tracks.filter(t => !ids.includes(t.id)); const at = afterId ? rest.findIndex(t => t.id === afterId) + 1 : 0; return { ...p, tracks: [...rest.slice(0, at), ...moving, ...rest.slice(at)] } }) },
    onNewTrack: opts => { say(`newTrack ${JSON.stringify(opts)}`); if (opts.dialog) return; const f = track(focusedTrackId); const kind = opts.kind ?? (opts.sameAsFocused ? f?.kind ?? 'instrument' : 'instrument'); const t = createTrack(kind, f?.kind === 'instrument' && opts.sameAsFocused && !opts.empty ? f.instrument : 'keys'); edit(p => insertTracks(p, opts.afterId === undefined ? focusedTrackId : opts.afterId, [t])); selectTracks(new Set([t.id]), t.id) },
    onDuplicateTracks: (ids, mode) => { say(`duplicate ${mode} ${ids.length}`); edit(p => { let out = p; for (const id of ids) { const t = out.tracks.find(x => x.id === id); if (t) out = insertTracks(out, id, [mode === 'content' ? duplicateTrack(t) : duplicateTrackSettings(t)]) } return out }) },
    onDeleteTracks: ids => { say(`delete ${ids.length}`); edit(p => ({ ...p, tracks: p.tracks.filter(t => !ids.includes(t.id)) })) },
    onRenameTracks: (ids, name) => { say(`rename ${ids.length} → ${name}`); setUi(u => ({ ...u, renamingTrackId: null })); if (name !== null) edit(p => ({ ...p, tracks: p.tracks.map(t => ids.includes(t.id) ? { ...t, name: ids.length > 1 ? `${name} ${ids.indexOf(t.id) + 1}` : name } : t) })) },
    onOpenLibrary: id => say(`library ${id}`),
    onOpenColorPalette: (ids, e) => say(`palette ${ids.length} @${e.x},${e.y}`),
    onIconMenu: (id, e) => say(`iconMenu ${id} @${e.x},${e.y}`),
    onConfigureHeader: e => say(`configureHeader @${e.x},${e.y}`),
    onClearRecallSolo: () => edit(p => { const r = clearRecallSolo(p, ui.soloRecall); setUi(u => ({ ...u, soloRecall: r.recall })); return r.project }),
    onSeek: b => { fakeEngine.seek(b); say(`seek ${b.toFixed(2)}`) },
    onSeekPlay: b => { fakeEngine.seek(b); void fakeEngine.play(); say(`seekPlay ${b.toFixed(2)}`) },
    onLoopChange: loop => { say(`loop ${JSON.stringify(loop)}`); edit(p => ({ ...p, loop })) },
    onSelectClips: (ids, anchor, trackId) => { setSelectedClips(new Set(ids)); setAnchor(anchor); if (trackId) selectTracks(new Set([trackId]), trackId); say(`selectClips ${ids.length} anchor=${anchor?.slice(0, 6) ?? '-'} ${trackId ? track(trackId)?.name : ''}`) },
    onClipMove: (moves, copy) => { say(`clipMove ${moves.length} copy=${copy} ${JSON.stringify(moves[0])}`); edit(p => { let out = { ...p, tracks: p.tracks.map(t => ({ ...t, clips: [...t.clips] })) }; for (const m of moves) { const from = out.tracks.find(t => t.id === m.trackId)!; const i = from.clips.findIndex(c => c.id === m.clipId); if (i < 0) continue; const c = from.clips[i]; let moved = { ...c, startBeat: m.start }; if (m.length !== undefined) moved = trimClipEnd(moved, m.start + m.length); if (copy) moved = { ...moved, id: `${c.id}-copy-${Date.now()}` }; else from.clips.splice(i, 1); const to = out.tracks.find(t => t.id === (m.toTrackId ?? m.trackId))!; to.clips.push(moved) } out = applyDragMode(out, [...new Set(moves.map(m => m.toTrackId ?? m.trackId))], moves.map(m => m.clipId), ui.dragMode); return out }) },
    onClipTrimStart: (trackId, clipId, newStart) => { say(`trimStart ${newStart.toFixed(2)}`); edit(p => ({ ...p, tracks: p.tracks.map(t => t.id === trackId ? { ...t, clips: t.clips.map(c => c.id === clipId ? trimClipStart(c, newStart, p.bpm) : c) } : t) })) },
    onClipLoopToggle: (trackId, clipId) => { say(`loopToggle ${clipId.slice(0, 6)}`); edit(p => ({ ...p, tracks: p.tracks.map(t => t.id === trackId ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, loop: !c.loop } : c) } : t) })) },
    onAddClip: (trackId, b) => say(`addClip ${track(trackId)?.name} @${b}`),
    onAudioDrop: files => say(`audioDrop ${files.length}`),
    onCommand: (command, ctx) => say(`command ${command} ${ctx ? JSON.stringify(ctx).slice(0, 60) : ''}`),
    onMarker: (action, payload) => { say(`marker ${action} ${JSON.stringify(payload)}`); edit(p => action === 'add' ? addMarker(p, createMarker(payload.beat ?? 0, payload.name ?? 'Marker')) : action === 'move' ? moveMarker(p, payload.id!, payload.beat ?? 0) : action === 'rename' ? renameMarker(p, payload.id!, payload.name ?? '') : deleteMarker(p, payload.id!)) },
    onClipOpen: (trackId, clipId) => say(`clipOpen ${clipId.slice(0, 6)} on ${track(trackId)?.name}`),
  }
  ;(window as unknown as { __tl: unknown; __tlPlay: () => void; __tlStop: () => void }).__tl = { project, ui, zoom, selectedTrackIds: [...selectedTrackIds], selectedClipIds: [...selectedClipIds], focusedTrackId, log }
  ;(window as unknown as { __tlPlay: () => void; __tlStop: () => void }).__tlPlay = () => { last = performance.now(); void fakeEngine.play() }
  ;(window as unknown as { __tlStop: () => void }).__tlStop = () => fakeEngine.pause()
  return <div className="studio-app" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--ink-09)', zIndex: 1000 }}>
    <div className="studio-main" style={{ flex: 1, minHeight: 0 }}><Timeline {...props}/></div>
    <pre id="harness-log" style={{ margin: 0, height: 96, overflow: 'auto', fontSize: 9, color: 'var(--ink-54)', background: 'var(--ink-12)', borderTop: '1px solid var(--ink-22)', padding: '4px 8px' }}>{log.join('\n')}</pre>
  </div>
}

document.getElementById('timeline-harness')?.remove()
const host = document.createElement('div')
host.id = 'timeline-harness'
document.body.appendChild(host)
createRoot(host).render(<StrictMode><Harness/></StrictMode>)
export {}
