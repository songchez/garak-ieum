import { MAX_MIDI_FILE_BYTES, parseMidiFile, type MidiImportResult } from './midiImport'
import { quarterNotesPerBar, validateTimeSignature } from './meter'
import { createTrack, fitProjectLength, insertTracks, MIN_CLIP_BEATS, uid, validateProject } from './project'
import type { AudioAsset, AudioClip, MidiClip, Project, Track } from './types'

export const MEDIA_FILE_ACCEPT = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aiff,.mid,.midi,.smf'
export type ImportedMedia =
  | { kind: 'audio'; name: string; asset: AudioAsset }
  | { kind: 'midi'; name: string; midi: MidiImportResult }

export function isMidiFile(file: Pick<File, 'name' | 'type'>): boolean {
  return /\.(mid|midi|smf)$/i.test(file.name) || /^(audio|application)\/(x-)?midi(?:;|$)/i.test(file.type)
}

/** MIDI is note data, so it must never enter the audio codec or open a device. */
export async function readMediaFile(file: File, decodeAudio: (file: File, name: string) => Promise<AudioAsset>): Promise<ImportedMedia> {
  const header = isMidiFile(file) ? null : new Uint8Array(await file.slice(0, 4).arrayBuffer())
  const midi = isMidiFile(file) || (header?.[0] === 0x4d && header[1] === 0x54 && header[2] === 0x68 && header[3] === 0x64)
  if (midi) {
    if (file.size > MAX_MIDI_FILE_BYTES) throw new Error('MIDI 파일은 최대 16 MB까지 가져올 수 있습니다.')
    return { kind: 'midi', name: file.name, midi: parseMidiFile(await file.arrayBuffer()) }
  }
  return { kind: 'audio', name: file.name, asset: await decodeAudio(file, file.name) }
}

export interface MediaImportPlan {
  project: Project
  assets: AudioAsset[]
  placements: Array<{ trackId: string; clipId: string; kind: 'audio' | 'midi' }>
  audioFiles: number
  midiFiles: number
  warnings: string[]
}

const filename = (name: string): string => name.replace(/\.[^.]+$/, '').trim().slice(0, 256) || '가져온 파일'

/** Build the complete edit before committing any project or asset changes. */
export function planMediaImport(project: Project, media: readonly ImportedMedia[], target: { trackId?: string; beat?: number } = {}): MediaImportPlan {
  const beat = target.beat ?? 0
  if (!Number.isFinite(beat) || beat < 0) throw new Error('파일을 놓을 위치가 유효하지 않습니다.')
  let next = project
  const warnings = new Set<string>(), assets: AudioAsset[] = [], placements: MediaImportPlan['placements'] = []
  const newTracks: Track[] = []
  let audioFiles = 0, midiFiles = 0, targetUsed = false
  const initialMidi = media.length === 1 && media[0].kind === 'midi' && !project.tracks.length && !project.markers.length && beat === 0 ? media[0].midi : null
  if (initialMidi) {
    if (initialMidi.bpm !== undefined) {
      if (Number.isFinite(initialMidi.bpm) && initialMidi.bpm >= 30 && initialMidi.bpm <= 300) next = { ...next, bpm: initialMidi.bpm }
      else warnings.add('MIDI의 초기 템포가 지원 범위(30–300 BPM)를 벗어나 프로젝트 템포를 유지했습니다.')
    }
    if (initialMidi.timeSignature) {
      try {
        const timeSignature = validateTimeSignature(initialMidi.timeSignature)
        next = { ...next, timeSignature, beatsPerBar: quarterNotesPerBar(timeSignature) }
      } catch { warnings.add('MIDI의 초기 박자가 지원 범위를 벗어나 프로젝트 박자를 유지했습니다.') }
    }
  }
  const append = (track: Track, clip: AudioClip | MidiClip, existing: boolean) => {
    if (existing) next = { ...next, tracks: next.tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item) }
    else newTracks.push({ ...track, clips: [clip] })
    placements.push({ trackId: track.id, clipId: clip.id, kind: clip.kind })
  }
  for (const item of media) {
    const name = filename(item.name)
    if (item.kind === 'audio') {
      if (!Number.isFinite(item.asset.buffer.duration) || item.asset.buffer.duration <= 0) throw new Error(`${item.name}: 오디오 길이가 유효하지 않습니다.`)
      const existing = !targetUsed && target.trackId ? next.tracks.find(track => track.id === target.trackId && track.kind === 'audio') : undefined
      if (existing) targetUsed = true
      const track = existing ?? { ...createTrack('audio'), name }
      const clip: AudioClip = { id: uid(), kind: 'audio', name, startBeat: beat, lengthBeats: item.asset.buffer.duration * next.bpm / 60, gain: 1,
        assetId: item.asset.id, offsetSeconds: 0, fadeIn: .005, fadeOut: .01 }
      assets.push(item.asset); audioFiles++
      append(track, clip, !!existing)
      continue
    }
    const parts = item.midi.tracks.filter(part => part.notes.length)
    if (!parts.length) throw new Error(`${item.name}: 가져올 수 있는 MIDI 음표가 없습니다.`)
    if (!Number.isFinite(item.midi.lengthBeats) || item.midi.lengthBeats <= 0) throw new Error(`${item.name}: MIDI 길이가 유효하지 않습니다.`)
    midiFiles++
    for (const warning of item.midi.warnings) warnings.add(`${item.name}: ${warning}`)
    if (!initialMidi && item.midi.bpm !== undefined && Math.abs(item.midi.bpm - next.bpm) > .000001) warnings.add('기존 작업의 템포를 유지했습니다. MIDI 음표는 프로젝트 템포에 맞춰 재생됩니다.')
    if (!initialMidi && item.midi.timeSignature && (item.midi.timeSignature.numerator !== next.timeSignature.numerator || item.midi.timeSignature.denominator !== next.timeSignature.denominator)) warnings.add('기존 작업의 박자를 유지했습니다. MIDI 음표의 박 위치는 그대로 가져왔습니다.')
    for (const part of parts) {
      // A multi-part file keeps its channel separation. A single part can use
      // the explicitly selected instrument, including its existing WAVE patch.
      const existing = !targetUsed && parts.length === 1 && target.trackId ? next.tracks.find(track => track.id === target.trackId && track.kind === 'instrument') : undefined
      if (existing) targetUsed = true
      const partName = part.name.trim().slice(0, 256) || (parts.length > 1 ? `${name} · 채널 ${part.channel + 1}` : name)
      const track = existing ?? { ...createTrack('instrument', part.channel === 9 ? 'drums' : 'keys'), name: partName }
      if (!existing && part.program !== undefined) warnings.add('MIDI 악기 지정은 기본 건반·드럼 음색에 연결했습니다. 라이브러리에서 원하는 음색으로 바꿀 수 있습니다.')
      const clip: MidiClip = { id: uid(), kind: 'midi', name: partName, startBeat: beat, lengthBeats: Math.max(MIN_CLIP_BEATS, item.midi.lengthBeats), gain: 1,
        notes: part.notes.map(note => ({ ...note, id: uid() })) }
      append(track, clip, !!existing)
    }
  }
  if (next.tracks.length + newTracks.length > 256) throw new Error('트랙은 최대 256개까지 가져올 수 있습니다. 파일을 나누거나 사용하지 않는 트랙을 정리해 주세요.')
  next = fitProjectLength(insertTracks(next, target.trackId ?? null, newTracks))
  if (!Number.isFinite(next.lengthBeats) || next.lengthBeats > 10_000_000) throw new Error('가져온 파일이 프로젝트의 길이 한도를 넘습니다.')
  // Batch totals can exceed project storage limits even when each MIDI file
  // is individually valid. Validate before the caller commits any assets.
  // Keep the original objects so an existing instrument/patch retains identity.
  validateProject(next)
  return { project: next, assets, placements, audioFiles, midiFiles, warnings: [...warnings] }
}
