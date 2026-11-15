import { describe, expect, it } from 'vitest'
import { createDevice, createEmptyProject, createTrack } from '../../core/project'
import type { AudioClip, MidiClip, MidiNote, Project, Track } from '../../core/types'
import { compileNativeTimeline, NativeTimelineCompiler, type NativePcmAsset } from './timeline'
import { BINARY_MIN_RECORDS, decodeControls, decodeNotes, encodeTracks, NOTE_RECORD_BYTES, planNativeSync, type SyncTimeline, type WireTrack } from './timelineSync'

let sequence = 0
const note = (start: number, pitch = 60): MidiNote => ({ id: `n${sequence++}`, start, duration: .25, pitch, velocity: .8 })
const midi = (id: string, notes: MidiNote[], patch: Partial<MidiClip> = {}): MidiClip => ({ id, kind: 'midi', name: id, startBeat: 0, lengthBeats: 16, gain: 1, notes, ...patch })
const track = (id: string, patch: Partial<Track> = {}): Track => ({ ...createTrack(patch.kind ?? 'instrument', patch.instrument ?? 'keys'), id, ...patch })
const project = (tracks: Track[], patch: Partial<Project> = {}): Project => ({ ...createEmptyProject(), id: 'project', bpm: 120, sampleRate: 48000, lengthBeats: 32,
  loop: { enabled: false, startBeat: 0, endBeat: 32 }, tracks, ...patch })
const dense = (id: string, count: number) => track(id, { clips: [midi(`${id}-clip`, Array.from({ length: count }, (_, i) => note(i * 16 / count, 48 + i % 24)))] })
const withTrack = (p: Project, id: string, edit: (track: Track) => Track): Project => ({ ...p, tracks: p.tracks.map(item => item.id === id ? edit(item) : item) })

/** What the host does with a project.patch (native/src/protocol.hpp patchTimeline), for round-trip checks. */
function applyWire(previous: SyncTimeline, plan: ReturnType<typeof planNativeSync>): SyncTimeline {
  const decode = (wire: WireTrack, base?: SyncTimeline['tracks'][number]) => {
    const { notesBinary, controlsBinary, ...rest } = wire
    const notes = notesBinary ? decodeNotes(plan.binary!, notesBinary) : rest.notes
    const controls = controlsBinary ? decodeControls(plan.binary!, controlsBinary) : rest.controls
    return { ...base, ...rest, notes: notes ?? base!.notes, controls: controls ?? base!.controls, audio: rest.audio ?? base!.audio,
      ...('automation' in rest ? {} : base?.automation ? { automation: base.automation } : {}) } as SyncTimeline['tracks'][number]
  }
  if (plan.method === 'project.set') {
    const timeline = plan.params.timeline as SyncTimeline & { tracks: WireTrack[] }
    return { ...timeline, tracks: timeline.tracks.map(item => decode(item)) }
  }
  const { header, order, tracks } = plan.params as { header: SyncTimeline; order: string[]; tracks: WireTrack[] }
  return { ...header, assets: previous.assets, tracks: order.map(id => {
    const before = previous.tracks.find(item => item.id === id)!, wire = tracks.find(item => item.id === id)
    return wire ? decode(wire, before) : before
  }) }
}
/** Event content without note bookkeeping the host does not receive (clip id, occurrence). */
const content = (timeline: SyncTimeline) => timeline.tracks.map(item => ({ ...item, notes: item.notes.map(({ id, onFrame, offFrame, limitFrame, pitch, velocity }) => ({ id, onFrame, offFrame, limitFrame, pitch, velocity: Math.fround(velocity) })),
  automation: item.automation ?? [] }))

describe('incremental native timeline compilation', () => {
  it('produces exactly what the full compiler produces and reuses untouched tracks', () => {
    const compiler = new NativeTimelineCompiler()
    let p = project([dense('a', 200), dense('b', 300), track('c', { devices: [createDevice('reverb')] })])
    expect(compiler.compile(p, new Map(), 1)).toEqual(compileNativeTimeline(p, new Map(), 1))
    expect(compiler.lastExpanded).toEqual(['a', 'b', 'c'])
    const first = compiler.compile(p, new Map(), 2)
    expect(compiler.lastExpanded).toEqual([])
    // Mixer and insert edits never re-expand events.
    p = withTrack(p, 'a', item => ({ ...item, volume: .4, pan: .2, devices: [createDevice('eq')] }))
    const mixed = compiler.compile(p, new Map(), 3)
    expect(compiler.lastExpanded).toEqual([])
    expect(mixed.tracks[0].notes).toBe(first.tracks[0].notes)
    expect(mixed).toEqual(compileNativeTimeline(p, new Map(), 3))
    // A note edit re-expands only its own track; its IDs start at 0 (independent of other tracks).
    p = withTrack(p, 'b', item => ({ ...item, clips: [{ ...item.clips[0], notes: [...(item.clips[0] as MidiClip).notes, note(15.5, 90)] } as MidiClip] }))
    const edited = compiler.compile(p, new Map(), 4)
    expect(compiler.lastExpanded).toEqual(['b'])
    expect(edited.tracks[0].notes).toBe(first.tracks[0].notes)
    expect(edited.tracks[1].notes.map(item => item.id).sort((x, y) => x - y)).toEqual(Array.from({ length: 301 }, (_, i) => i))
    expect(edited).toEqual(compileNativeTimeline(p, new Map(), 4))
    // Tempo changes the frame grid of every track.
    p = { ...p, bpm: 100 }
    compiler.compile(p, new Map(), 5)
    expect(compiler.lastExpanded).toEqual(['a', 'b', 'c'])
  })

  it('keys audio windows on the decoded PCM metadata', () => {
    const clip: AudioClip = { id: 'take', kind: 'audio', name: 'take', assetId: 'pcm', startBeat: 0, lengthBeats: 4, offsetSeconds: 0, gain: 1, fadeIn: 0, fadeOut: 0 }
    const p = project([track('audio', { kind: 'audio', clips: [clip] })])
    const asset = (frames: number): Map<string, NativePcmAsset> => new Map([['pcm', { id: 'pcm', sampleRate: 48000, frames, channels: 2 }]])
    const compiler = new NativeTimelineCompiler()
    compiler.compile(p, asset(96000)); compiler.compile(p, asset(96000))
    expect(compiler.lastExpanded).toEqual([])
    const shorter = compiler.compile(p, asset(24000))
    expect(compiler.lastExpanded).toEqual(['audio'])
    expect(shorter.tracks[0].audio[0].endFrame).toBe(24000)
  })

  it('still rejects expansion limits across reused and new tracks', () => {
    const compiler = new NativeTimelineCompiler()
    const p = project([dense('a', 60_000)])
    compiler.compile(p)
    expect(() => compiler.compile({ ...p, tracks: [...p.tracks, dense('b', 50_000)] })).toThrow(/source notes|expanded note/)
  })
})

describe('binary event encoding', () => {
  it('round-trips notes and controllers through the binary frame and keeps short arrays as JSON', () => {
    const timeline = compileNativeTimeline(project([dense('big', 500), dense('small', 3)]))
    const encoded = encodeTracks(timeline.tracks)
    expect(encoded.tracks[0].notes).toBeUndefined()
    expect(encoded.tracks[0].notesBinary).toEqual({ offset: 0, count: 500 })
    expect(encoded.tracks[1].notes).toHaveLength(3)
    expect(encoded.binary!.byteLength).toBe(500 * NOTE_RECORD_BYTES)
    const decoded = decodeNotes(encoded.binary!, encoded.tracks[0].notesBinary!)
    expect(decoded).toEqual(timeline.tracks[0].notes.map(({ id, onFrame, offFrame, limitFrame, pitch, velocity }) => ({ id, onFrame, offFrame, limitFrame, pitch, velocity: Math.fround(velocity) })))
    const controls = Array.from({ length: BINARY_MIN_RECORDS }, (_, i) => ({ frame: i * 10, controller: i % 2 ? 129 : 1, value: i % 2 ? -8192 + i : i }))
    const withControls = encodeTracks([{ ...timeline.tracks[1], controls }])
    expect(decodeControls(withControls.binary!, withControls.tracks[0].controlsBinary!)).toEqual(controls)
    // 24 bytes per note instead of ~120 characters of JSON.
    expect(encoded.binary!.byteLength).toBeLessThan(JSON.stringify(timeline.tracks[0].notes).length / 4)
  })
})

describe('native sync planning', () => {
  const compile = (compiler: NativeTimelineCompiler, p: Project, revision: number) => compiler.compile(p, new Map(), revision)

  it('sends the full timeline first, then only changed tracks and only their changed event arrays', () => {
    const compiler = new NativeTimelineCompiler()
    let p = project([dense('a', 400), dense('b', 400), dense('c', 400)])
    const initial = compile(compiler, p, 1)
    const set = planNativeSync(null, initial)
    expect(set.method).toBe('project.set')
    expect(content(applyWire(initial, set))).toEqual(content(initial))
    // Fader: one light track, no events, no binary frame.
    p = withTrack(p, 'b', item => ({ ...item, volume: .3 }))
    const fader = compile(compiler, p, 2)
    const tick = planNativeSync(initial, fader)
    expect(tick.method).toBe('project.patch')
    expect(tick.changed).toEqual(['b'])
    expect(tick.binary).toBeNull()
    const sent = (tick.params.tracks as WireTrack[])[0]
    expect(sent).toMatchObject({ id: 'b', gain: .3 })
    expect(sent.notes).toBeUndefined(); expect(sent.notesBinary).toBeUndefined(); expect(sent.audio).toBeUndefined()
    expect(JSON.stringify(tick.params).length).toBeLessThan(2000)
    expect(content(applyWire(initial, tick))).toEqual(content(fader))
    // Note edit: that track's notes in the binary frame, nothing else.
    p = withTrack(p, 'c', item => ({ ...item, clips: [{ ...item.clips[0], notes: (item.clips[0] as MidiClip).notes.slice(1) } as MidiClip] }))
    const edited = compile(compiler, p, 3)
    const edit = planNativeSync(fader, edited)
    expect(edit.method).toBe('project.patch')
    expect(edit.changed).toEqual(['c'])
    expect(edit.binary!.byteLength).toBe(399 * NOTE_RECORD_BYTES)
    expect(content(applyWire(fader, edit))).toEqual(content(edited))
    // Nothing changed: an empty patch still carries the revision.
    const same = planNativeSync(edited, compile(compiler, p, 4))
    expect(same).toMatchObject({ method: 'project.patch', changed: [], params: { revision: 4 } })
  })

  it('falls back to project.set for tempo, length, order and IEUM WAVE source changes', () => {
    const compiler = new NativeTimelineCompiler()
    const p = project([dense('a', 10), track('wave', { instrument: 'wavetable' })])
    const base = compile(compiler, p, 1)
    expect(planNativeSync(base, compile(compiler, { ...p, bpm: 90 }, 2)).method).toBe('project.set')
    expect(planNativeSync(base, compile(compiler, { ...p, lengthBeats: 40, loop: { enabled: false, startBeat: 0, endBeat: 40 } }, 2)).method).toBe('project.set')
    expect(planNativeSync(base, compile(compiler, { ...p, tracks: [...p.tracks].reverse() }, 2)).method).toBe('project.set')
    const wave = withTrack(p, 'wave', item => ({ ...item, instrumentParams: { ...item.instrumentParams, macro1: .9 } }))
    expect(planNativeSync(base, compile(compiler, wave, 2)).method).toBe('project.set')
    // Master volume is a header field a patch carries.
    expect(planNativeSync(base, compile(compiler, { ...p, masterVolume: .5 }, 2)).method).toBe('project.patch')
  })
})
