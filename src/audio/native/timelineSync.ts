import type { NativeControlEvent, NativeNotePair, NativeProjectTimeline, NativeTrackTimeline } from './timeline'


/**
 * Renderer → native host synchronization (R3/R4, docs/RENDER_DIFF_PROTOCOL.md).
 *
 * The first sync of a device/process sends the whole timeline (`project.set`). Later syncs send only the tracks
 * that changed (`project.patch`), and inside a changed track only the event arrays that changed. Large note and
 * controller arrays travel as one binary frame next to the JSON request instead of millions of JSON characters.
 * The host merges a patch into its copy and hands the result to RenderEngine::update(), which applies the
 * smallest diff to the running graph.
 */

/** Bytes per record in the binary frame (little endian). Note: int32 id, onFrame, offFrame, limitFrame,
 * pitch; float32 velocity. Control: int32 frame, controller, value. Frames fit int32 (≤ 3600 s × 192 kHz). */
export const NOTE_RECORD_BYTES = 24
export const CONTROL_RECORD_BYTES = 12
/** Arrays at least this long go into the binary frame; shorter ones stay readable JSON. */
export const BINARY_MIN_RECORDS = 64

export interface BinaryRef { readonly offset: number; readonly count: number }
type HeavyField = 'notes' | 'controls' | 'audio' | 'automation'
const HEAVY: readonly HeavyField[] = ['notes', 'controls', 'audio', 'automation']

/** A compiled track as the engine sends it: the source may already be in its wire form (IEUM WAVE patchData). */
export type SyncTrack = Omit<NativeTrackTimeline, 'source'> & { readonly source: { readonly kind: string } }
/** A compiled timeline as the engine sends it. */
export type SyncTimeline = Omit<NativeProjectTimeline, 'tracks'> & { readonly tracks: readonly SyncTrack[]; readonly lowLatencyMonitoring?: boolean }

/** A track as it crosses the bridge: notes/controls either JSON arrays or binary references. */
export type WireTrack = Omit<SyncTrack, 'notes' | 'controls' | 'audio'> & {
  notes?: readonly NativeNotePair[]
  controls?: readonly NativeControlEvent[]
  audio?: NativeTrackTimeline['audio']
  notesBinary?: BinaryRef
  controlsBinary?: BinaryRef
}

/**
 * Wire form of tracks. `include(track, field)` false leaves a heavy field out (the host keeps its value).
 * Returns null binary when no array was large enough.
 */
export function encodeTracks(tracks: readonly SyncTrack[], include: (track: SyncTrack, field: HeavyField) => boolean = () => true): { tracks: WireTrack[]; binary: Uint8Array | null } {
  let bytes = 0
  for (const track of tracks) {
    if (include(track, 'notes') && track.notes.length >= BINARY_MIN_RECORDS) bytes += track.notes.length * NOTE_RECORD_BYTES
    if (include(track, 'controls') && track.controls.length >= BINARY_MIN_RECORDS) bytes += track.controls.length * CONTROL_RECORD_BYTES
  }
  const buffer = bytes ? new ArrayBuffer(bytes) : null
  const ints = buffer ? new Int32Array(buffer) : null, floats = buffer ? new Float32Array(buffer) : null
  let offset = 0
  const wire = tracks.map(track => {
    const { notes, controls, audio, automation, ...light } = track
    const out: WireTrack = { ...light }
    if (include(track, 'notes')) {
      if (ints && floats && notes.length >= BINARY_MIN_RECORDS) {
        out.notesBinary = { offset, count: notes.length }
        let at = offset >> 2
        for (const note of notes) {
          ints[at] = note.id; ints[at + 1] = note.onFrame; ints[at + 2] = note.offFrame; ints[at + 3] = note.limitFrame; ints[at + 4] = note.pitch; floats[at + 5] = note.velocity
          at += 6
        }
        offset += notes.length * NOTE_RECORD_BYTES
      } else out.notes = notes
    }
    if (include(track, 'controls')) {
      if (ints && controls.length >= BINARY_MIN_RECORDS) {
        out.controlsBinary = { offset, count: controls.length }
        let at = offset >> 2
        for (const control of controls) { ints[at] = control.frame; ints[at + 1] = control.controller; ints[at + 2] = control.value; at += 3 }
        offset += controls.length * CONTROL_RECORD_BYTES
      } else out.controls = controls
    }
    if (include(track, 'audio')) out.audio = audio
    if (include(track, 'automation')) (out as { automation?: NativeTrackTimeline['automation'] }).automation = automation ?? []
    return out
  })
  // Int32Array/Float32Array write the platform byte order; every supported desktop (x64, arm64) is little endian.
  return { tracks: wire, binary: buffer ? new Uint8Array(buffer) : null }
}

/** Reads notes back from a binary frame (tests; the host has its own reader). */
export function decodeNotes(binary: Uint8Array, ref: BinaryRef): { id: number; onFrame: number; offFrame: number; limitFrame: number; pitch: number; velocity: number }[] {
  const view = new DataView(binary.buffer, binary.byteOffset + ref.offset, ref.count * NOTE_RECORD_BYTES)
  return Array.from({ length: ref.count }, (_, i) => {
    const at = i * NOTE_RECORD_BYTES
    return { id: view.getInt32(at, true), onFrame: view.getInt32(at + 4, true), offFrame: view.getInt32(at + 8, true), limitFrame: view.getInt32(at + 12, true), pitch: view.getInt32(at + 16, true), velocity: view.getFloat32(at + 20, true) }
  })
}
export function decodeControls(binary: Uint8Array, ref: BinaryRef): NativeControlEvent[] {
  const view = new DataView(binary.buffer, binary.byteOffset + ref.offset, ref.count * CONTROL_RECORD_BYTES)
  return Array.from({ length: ref.count }, (_, i) => ({ frame: view.getInt32(i * 12, true), controller: view.getInt32(i * 12 + 4, true), value: view.getInt32(i * 12 + 8, true) }))
}

/** Header fields a patch can carry. A change to any other header field (or the track order) is a full sync. */
function header(timeline: SyncTimeline): Omit<SyncTimeline, 'tracks' | 'assets'> {
  const { tracks: _tracks, assets: _assets, ...rest } = timeline
  return rest
}
const timing = (timeline: SyncTimeline) => JSON.stringify([timeline.projectId, timeline.sampleRate, timeline.bpm, timeline.tempoMap ?? null, timeline.meterMap ?? null,
  timeline.timeSignature, timeline.beatsPerBar, timeline.lengthFrames, timeline.cycle, timeline.lowLatencyMonitoring ?? true, timeline.tracks.map(track => track.id)])
const sameArray = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => a === b || (!a?.length && !b?.length)
const light = (track: SyncTrack) => { const { notes: _n, controls: _c, audio: _a, automation: _m, ...rest } = track; return JSON.stringify(rest) }

export interface NativeSyncPlan {
  readonly method: 'project.set' | 'project.patch'
  readonly params: Record<string, unknown>
  readonly binary: Uint8Array | null
  /** Track ids sent in a patch (every track for project.set). */
  readonly changed: readonly string[]
}

/**
 * The request that brings the host from `previous` (the last timeline it acknowledged in this process and
 * device configuration, or null) to `next`. Event arrays reused by NativeTimelineCompiler are the same objects,
 * so an unchanged track costs one light comparison. IEUM WAVE source changes stay on project.set: the host
 * rebuilds the graph for them and the WAVE editor waits for that acknowledgment (awaitApplied).
 */
export function planNativeSync(previous: SyncTimeline | null, next: SyncTimeline): NativeSyncPlan {
  const full = (): NativeSyncPlan => {
    const encoded = encodeTracks(next.tracks)
    return { method: 'project.set', params: { timeline: { ...next, tracks: encoded.tracks } }, binary: encoded.binary, changed: next.tracks.map(track => track.id) }
  }
  if (!previous || timing(previous) !== timing(next)) return full()
  const changed: SyncTrack[] = [], fields = new Map<SyncTrack, Set<HeavyField>>()
  for (let index = 0; index < next.tracks.length; index++) {
    const before = previous.tracks[index], after = next.tracks[index]
    if (before === after) continue
    const heavy = new Set(HEAVY.filter(field => !sameArray(before[field], after[field])))
    const lightChanged = light(before) !== light(after)
    if (!heavy.size && !lightChanged) continue
    if (lightChanged && (before.source.kind === 'native-wavetable' || after.source.kind === 'native-wavetable') && JSON.stringify(before.source) !== JSON.stringify(after.source)) return full()
    changed.push(after); fields.set(after, heavy)
  }
  const encoded = encodeTracks(changed, (track, field) => fields.get(track)!.has(field))
  return { method: 'project.patch', params: { revision: next.revision, header: header(next), order: next.tracks.map(track => track.id), tracks: encoded.tracks },
    binary: encoded.binary, changed: changed.map(track => track.id) }
}
