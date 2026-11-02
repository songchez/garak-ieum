import { createDevice, createEmptyProject, createTrack, uid } from '../project'
import type { EffectType, MidiClip, Project, Track } from '../types'

/** Authored MIDI events: pitch, local beat, duration in beats, velocity (0…1). */
export type Event = readonly [number, number, number, number]
export type SectionKind = 'intro' | 'verse' | 'hook' | 'break' | 'return' | 'outro'
export interface Section { name: string; bar: number; bars: number; kind: SectionKind }

export function session(name: string, bpm: number, bars: number, sections: readonly Section[]): Project {
  const project = createEmptyProject()
  project.name = name
  project.bpm = bpm
  project.lengthBeats = bars * 4
  project.masterVolume = 0.74
  const hook = sections.find(section => section.kind === 'hook')!
  project.loop = { enabled: false, startBeat: hook.bar * 4, endBeat: (hook.bar + hook.bars) * 4 }
  project.markers = sections.map(section => ({ id: uid(), name: section.name, startBeat: section.bar * 4 }))
  return project
}

export function part(instrument: string, name: string, volume: number, pan = 0, params: Record<string, number> = {}): Track {
  const track = createTrack('instrument', instrument)
  track.name = name
  track.volume = volume
  track.pan = pan
  Object.assign(track.instrumentParams, params)
  return track
}

export function insert(track: Track, type: EffectType, params: Record<string, number>): void {
  track.devices.push(createDevice(type, params))
}

/** Each written phrase is a distinct editable region, never an implicit infinite loop. */
export function phrase(track: Track, name: string, bar: number, bars: number, events: readonly Event[], gain = 1): void {
  if (!events.length) return
  const clip: MidiClip = {
    id: uid(), kind: 'midi', name, startBeat: bar * 4, lengthBeats: bars * 4, gain,
    notes: [...events].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([pitch, start, duration, velocity]) =>
      ({ id: uid(), pitch, start, duration, velocity })),
  }
  track.clips.push(clip)
}

export function shifted(events: readonly Event[], beats: number, strength = 1): Event[] {
  return events.map(([pitch, start, duration, velocity]) => [pitch, start + beats, duration, velocity * strength])
}

export function hits(pitch: number, starts: readonly number[], velocity = 0.7, duration = 0.12): Event[] {
  return starts.map(start => [pitch, start, duration, velocity])
}

export function sectionAt(sections: readonly Section[], bar: number): Section {
  return sections.find(section => bar >= section.bar && bar < section.bar + section.bars)!
}
