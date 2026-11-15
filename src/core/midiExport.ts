import { instrumentDef, isInstrumentId } from './instruments'
import { clipOccurrences, isTrackEnabled, playbackNotes, playbackSustain } from './playback'
import type { Project, Track } from './types'

/**
 * Standard MIDI File (Type 1, 960 PPQ) of every MIDI region as it plays: loops expanded, region quantize,
 * transpose, velocity and delay applied, the sustain pedal kept as CC64 controller events (never baked into
 * note lengths). One MTrk per instrument track with MIDI; kits use channel 10. docs/SUSTAIN_PEDAL.md.
 */
export const MIDI_EXPORT_PPQ = 960

const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]

interface TimedEvent { tick: number; order: number; bytes: number[] }

function variable(value: number): number[] {
  const bytes = [value & 0x7f]
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80)
  return bytes
}
const text = (value: string): number[] => Array.from(new TextEncoder().encode(value.slice(0, 120)))
const chunk = (id: string, body: number[]): number[] => [...Array.from(id, c => c.charCodeAt(0)), (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body]

function trackChunk(events: TimedEvent[]): number[] {
  // Same tick: pedal changes first (a pedal-down catches a note-off at that tick, like playback), then offs, then ons.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const body: number[] = []
  let last = 0
  for (const event of events) { body.push(...variable(event.tick - last), ...event.bytes); last = event.tick }
  body.push(0, 0xff, 0x2f, 0)
  return chunk('MTrk', body)
}

export function writeMidiFile(project: Project, tracks: readonly Track[] = project.tracks): Uint8Array<ArrayBuffer> {
  const tick = (beat: number) => Math.max(0, Math.round(beat * MIDI_EXPORT_PPQ))
  const microseconds = Math.round(60_000_000 / project.bpm)
  const denominatorPower = Math.round(Math.log2(project.timeSignature.denominator))
  const conductor = trackChunk([
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...variable(text(project.name).length), ...text(project.name)] },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 3, (microseconds >> 16) & 255, (microseconds >> 8) & 255, microseconds & 255] },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 4, project.timeSignature.numerator, denominatorPower, 24, 8] },
  ])
  const chunks: number[][] = [conductor]
  let melodic = 0
  for (const track of tracks) {
    if (track.kind !== 'instrument' || !isTrackEnabled(track) || !track.clips.some(clip => clip.kind === 'midi' && !clip.mute)) continue
    const kit = isInstrumentId(track.instrument) && instrumentDef(track.instrument).isKit
    const channel = kit ? 9 : MELODIC_CHANNELS[melodic++ % MELODIC_CHANNELS.length]
    const events: TimedEvent[] = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...variable(text(track.name).length), ...text(track.name)] }]
    for (const clip of track.clips) {
      if (clip.kind !== 'midi' || clip.mute) continue
      for (const occurrence of clipOccurrences(track, clip, project.lengthBeats)) {
        for (const event of playbackSustain(track, clip, occurrence)) events.push({ tick: tick(event.beat), order: 1, bytes: [0xb0 | channel, 64, event.value] })
        for (const note of playbackNotes(track, { ...clip, gain: 1 }, occurrence, false)) {
          const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)))
          const on = tick(note.start), off = Math.max(on + 1, tick(note.end))
          events.push({ tick: on, order: 3, bytes: [0x90 | channel, note.pitch, velocity] }, { tick: off, order: 2, bytes: [0x80 | channel, note.pitch, 0] })
        }
      }
    }
    chunks.push(trackChunk(events))
  }
  if (chunks.length === 1) throw new Error('내보낼 MIDI 리전이 없습니다.')
  const header = chunk('MThd', [0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (MIDI_EXPORT_PPQ >> 8) & 255, MIDI_EXPORT_PPQ & 255])
  return new Uint8Array([...header, ...chunks.flat()])
}
