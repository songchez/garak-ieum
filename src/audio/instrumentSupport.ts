import { instrumentDef } from '../core/instruments'
import { audibleTrackIds, clipOccurrences, playbackNotes } from '../core/playback'
import type { AudioEngine, InstrumentId, Project, Track } from '../core/types'

export const WAVETABLE_HOST_REQUIRED = 'IEUM WAVE의 소리를 들으려면 네이티브 오디오 엔진 연결이 필요합니다. 음색 편집과 프로젝트 저장은 사용할 수 있습니다.'

/** Native availability is an explicit host capability, never inferred from Electron alone. */
export function canPlayInstrument(engine: AudioEngine, instrument: InstrumentId): boolean {
  if (instrumentDef(instrument).kind !== 'native') return true
  return instrument === 'wavetable' && engine.kind === 'native'
    && engine.wavetable?.protocolVersion === 1 && engine.wavetable.getStatus().available === true
}

function hasPlayableNotes(track: Track, projectEnd: number): boolean {
  return track.clips.some(clip => {
    if (clip.kind !== 'midi' || clip.mute || clip.gain <= 0) return false
    // Use the same source trim, quantization, pitch/velocity limits and gain as
    // the scheduler. Expand the source once, not once per repeated occurrence.
    const notes = playbackNotes(track, clip, { start: clip.startBeat, end: clip.startBeat + clip.lengthBeats, index: 0 })
    if (!notes.length) return false
    const delay = notes[0].limit - clip.startBeat - clip.lengthBeats
    return clipOccurrences(track, clip, projectEnd).some(occurrence => {
      const shift = occurrence.start - clip.startBeat
      return notes.some(note => {
        const start = note.start + shift
        const end = Math.min(note.end + shift, occurrence.end + delay)
        return note.velocity > 0 && start < projectEnd && end > Math.max(0, start)
      })
    })
  })
}

/** Empty, disabled, muted and non-solo native tracks must not block the rest of a session. */
export function unsupportedWebAudioInstruments(project: Project): string[] {
  if (project.masterVolume <= 0) return []
  const audible = audibleTrackIds(project.tracks)
  return project.tracks.filter(track => track.kind === 'instrument'
    && instrumentDef(track.instrument).kind === 'native' && audible.has(track.id)
    && track.volume > 0 && hasPlayableNotes(track, project.lengthBeats))
    .map(track => track.name)
}

export function assertWebAudioProjectSupported(project: Project): void {
  const tracks = unsupportedWebAudioInstruments(project)
  if (tracks.length) throw new Error(`${WAVETABLE_HOST_REQUIRED} 대상 트랙: ${tracks.slice(0, 4).join(', ')}${tracks.length > 4 ? '…' : ''}`)
}
