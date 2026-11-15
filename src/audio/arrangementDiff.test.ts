import { describe, expect, it } from 'vitest'
import { createDemoProject, createDevice, createTrack, uid } from '../core/project'
import { setProjectTimeSignature } from '../core/meter'
import { setTempoAt } from '../core/tempoMap'
import type { MidiClip, Project, Track } from '../core/types'
import { arrangementChanged, diffArrangement } from './arrangementDiff'

const base = (): Project => createDemoProject()
const firstMidi = (project: Project): { track: Track; clip: MidiClip } => {
  for (const track of project.tracks) for (const clip of track.clips) if (clip.kind === 'midi' && clip.notes.length) return { track, clip }
  throw new Error('demo has MIDI')
}
const withTrack = (project: Project, id: string, edit: (track: Track) => Track): Project => ({ ...project, tracks: project.tracks.map(track => track.id === id ? edit(track) : track) })
const withClip = (project: Project, clipId: string, edit: (clip: MidiClip) => MidiClip): Project => ({
  ...project,
  tracks: project.tracks.map(track => track.clips.some(clip => clip.id === clipId) ? { ...track, clips: track.clips.map(clip => clip.id === clipId && clip.kind === 'midi' ? edit(clip) : clip) } : track),
})

describe('arrangement diff (identity over immutable snapshots)', () => {
  const project = base()
  const { track, clip } = firstMidi(project)

  it('reports nothing for the same snapshot and for mixer-only edits', () => {
    expect(arrangementChanged(diffArrangement(project, project))).toBe(false)
    for (const edit of [
      (t: Track) => ({ ...t, volume: t.volume * 0.5 }),
      (t: Track) => ({ ...t, pan: 0.3 }),
      (t: Track) => ({ ...t, mute: !t.mute }),
      (t: Track) => ({ ...t, solo: !t.solo }),
      (t: Track) => ({ ...t, name: 'renamed' }),
      (t: Track) => ({ ...t, color: '#123456' }),
      (t: Track) => ({ ...t, devices: [...t.devices, createDevice('eq')] }),
      (t: Track) => ({ ...t, instrumentParams: { ...t.instrumentParams, cutoff: 0.2 } }),
      // A rebuilt but equal limit is not a change.
      (t: Track) => ({ ...t, keyLimit: [...t.keyLimit] as [number, number] }),
    ]) expect(arrangementChanged(diffArrangement(project, withTrack(project, track.id, edit)))).toBe(false)
    expect(arrangementChanged(diffArrangement(project, { ...project, name: 'x', loop: { ...project.loop } }))).toBe(false)
  })

  it.each([
    ['note added', (c: MidiClip) => ({ ...c, notes: [...c.notes, { id: uid(), pitch: 64, start: 0.5, duration: 0.25, velocity: 0.7 }] })],
    ['note moved', (c: MidiClip) => ({ ...c, notes: c.notes.map((n, i) => i === 0 ? { ...n, start: n.start + 0.25 } : n) })],
    ['note transposed', (c: MidiClip) => ({ ...c, notes: c.notes.map((n, i) => i === 0 ? { ...n, pitch: n.pitch + 1 } : n) })],
    ['note velocity', (c: MidiClip) => ({ ...c, notes: c.notes.map((n, i) => i === 0 ? { ...n, velocity: 0.1 } : n) })],
    ['note removed', (c: MidiClip) => ({ ...c, notes: c.notes.slice(1) })],
    ['region moved', (c: MidiClip) => ({ ...c, startBeat: c.startBeat + 1 })],
    ['region resized', (c: MidiClip) => ({ ...c, lengthBeats: c.lengthBeats + 1 })],
    ['region muted', (c: MidiClip) => ({ ...c, mute: true })],
    ['region looped', (c: MidiClip) => ({ ...c, loop: !c.loop })],
    ['region quantize/swing', (c: MidiClip) => ({ ...c, quantize: 0.5, swing: 60 })],
    ['region transpose', (c: MidiClip) => ({ ...c, transpose: 3 })],
    ['sustain lane', (c: MidiClip) => ({ ...c, sustain: [{ beat: 0, value: 127 }] })],
    ['controller lane', (c: MidiClip) => ({ ...c, controllers: { cc1: [{ beat: 0, value: 64 }] } })],
  ])('detects a %s as a soft change of that track only', (_name, edit) => {
    const diff = diffArrangement(project, withClip(project, clip.id, edit))
    expect(diff.global).toBe(false)
    expect([...diff.tracks]).toEqual([[track.id, 'soft']])
  })

  it('detects region add/remove and a new identity with equal content (never misses an edit)', () => {
    const added = withTrack(project, track.id, t => ({ ...t, clips: [...t.clips, { ...clip, id: uid(), startBeat: 40 }] }))
    expect([...diffArrangement(project, added).tracks]).toEqual([[track.id, 'soft']])
    const removed = withTrack(project, track.id, t => ({ ...t, clips: t.clips.slice(1) }))
    expect([...diffArrangement(project, removed).tracks]).toEqual([[track.id, 'soft']])
    const cloned = withClip(project, clip.id, c => structuredClone(c))
    expect([...diffArrangement(project, cloned).tracks]).toEqual([[track.id, 'soft']])
    // A rebuilt array with the same clip objects is unchanged.
    expect(arrangementChanged(diffArrangement(project, withTrack(project, track.id, t => ({ ...t, clips: [...t.clips] }))))).toBe(false)
  })

  it.each([
    ['instrument', (t: Track) => ({ ...t, instrument: t.instrument === 'keys' ? 'pad' as const : 'keys' as const })],
    ['enabled', (t: Track) => ({ ...t, enabled: !t.enabled })],
    ['track transpose', (t: Track) => ({ ...t, transpose: t.transpose + 2 })],
    ['velocity offset', (t: Track) => ({ ...t, velocityOffset: 10 })],
    ['key limit', (t: Track) => ({ ...t, keyLimit: [10, 100] as [number, number] })],
    ['velocity limit', (t: Track) => ({ ...t, velocityLimit: [10, 100] as [number, number] })],
    ['delay', (t: Track) => ({ ...t, delayTicks: 24 })],
  ])('detects a %s change as hard', (_name, edit) => {
    expect([...diffArrangement(project, withTrack(project, track.id, edit)).tracks]).toEqual([[track.id, 'hard']])
  })

  it.each([
    ['tempo', (p: Project) => ({ ...p, bpm: p.bpm + 1 })],
    ['tempo map', (p: Project) => setTempoAt(p, 8, p.bpm + 20)],
    ['length', (p: Project) => ({ ...p, lengthBeats: p.lengthBeats + 4 })],
    ['loop', (p: Project) => ({ ...p, loop: { ...p.loop, enabled: !p.loop.enabled } })],
    ['meter', (p: Project) => setProjectTimeSignature(p, 3, 4)],
    ['track added', (p: Project) => ({ ...p, tracks: [...p.tracks, createTrack('instrument')] })],
    ['track removed', (p: Project) => ({ ...p, tracks: p.tracks.slice(1) })],
    ['tracks reordered', (p: Project) => ({ ...p, tracks: [...p.tracks].reverse() })],
  ])('treats a %s edit as global', (_name, edit) => {
    expect(diffArrangement(project, edit(project)).global).toBe(true)
  })

  it('treats the first project as global', () => {
    expect(diffArrangement(null, project).global).toBe(true)
  })

  it('stays under 3 ms for one edit on a 66k-note project (was 26 ms with JSON.stringify)', () => {
    const demo = createDemoProject()
    const tracks: Track[] = []
    for (let i = 0; i < 32; i++) {
      const src = demo.tracks[i % demo.tracks.length]
      const clips = []
      for (let r = 0; r < 32; r++) for (const c of src.clips) {
        if (c.kind !== 'midi') continue
        const notes = []
        for (let d = 0; d < 2; d++) for (const n of c.notes) notes.push({ ...n, id: uid(), start: Math.min(c.lengthBeats - 0.01, n.start + d * 0.01) })
        clips.push({ ...c, id: uid(), startBeat: c.startBeat + r * 32, notes })
      }
      tracks.push({ ...src, id: uid(), clips })
    }
    const large: Project = { ...demo, tracks, lengthBeats: 32 * 32 }
    const target = large.tracks[5]
    const edited = withTrack(large, target.id, t => ({ ...t, clips: t.clips.map((c, i) => i === 0 && c.kind === 'midi' ? { ...c, notes: c.notes.slice(1) } : c) }))
    diffArrangement(large, edited)
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) diffArrangement(large, edited)
    const ms = (performance.now() - t0) / 50
    const key = performance.now(); JSON.stringify([large.bpm, large.tempoMap, large.lengthBeats, large.loop, large.timeSignature, edited.tracks.map(t => [t.id, t.kind, t.instrument, t.enabled, t.transpose, t.velocityOffset, t.keyLimit, t.velocityLimit, t.delayTicks, t.clips])])
    console.info(`arrangement change detection, 66k notes: identity diff ${ms.toFixed(4)} ms vs former JSON key ${(performance.now() - key).toFixed(1)} ms`)
    expect(ms).toBeLessThan(3)
    expect([...diffArrangement(large, edited).tracks]).toEqual([[target.id, 'soft']])
  })
})
