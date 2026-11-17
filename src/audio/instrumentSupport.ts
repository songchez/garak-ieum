import { instrumentDef } from '../core/instruments'
import { audibleTrackIds, clipOccurrences, playbackNotes } from '../core/playback'
import type { AudioEngine, InstrumentId, Project, Track, VintageBridge } from '../core/types'

/** IEUM WAVE renders only in the Rust engine (docs/IEUM_WAVE.md): the desktop host's, or garak-engine.wasm in the browser. */
export const WAVETABLE_HOST_REQUIRED = 'IEUM WAVE의 소리를 들으려면 Rust 오디오 엔진(데스크톱 네이티브 엔진 또는 브라우저의 WASM 엔진)이 필요합니다. 음색 편집과 프로젝트 저장은 사용할 수 있습니다.'

export const VINTAGE_ENGINE_REQUIRED = '빈티지 악기(옥구슬 EP · 한밤 106)는 Rust 오디오 코어가 있어야 소리가 납니다. 음색 편집과 프로젝트 저장은 사용할 수 있습니다.'

/** Why `instrument` cannot play on `engine` (for tooltips); empty when it can. */
export function instrumentUnavailableReason(engine: AudioEngine, instrument: InstrumentId): string {
  if (canPlayInstrument(engine, instrument)) return ''
  return instrumentDef(instrument).kind === 'vintage' ? engine.vintage?.reason() || VINTAGE_ENGINE_REQUIRED : engine.wavetable?.getStatus().reason || WAVETABLE_HOST_REQUIRED
}

/**
 * IEUM WAVE availability is an explicit engine capability (the desktop host's handshake, or the browser engine's
 * garak-engine.wasm), never inferred from Electron or a browser alone.
 */
export function canPlayInstrument(engine: AudioEngine, instrument: InstrumentId): boolean {
  const kind = instrumentDef(instrument).kind
  // Vintage instruments exist only in the Rust core: the engine says whether it has it.
  if (kind === 'vintage') return engine.vintage?.available() === true
  if (kind !== 'native') return true
  return instrument === 'wavetable' && engine.wavetable?.protocolVersion === 1 && engine.wavetable.getStatus().available === true
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

/** Sources that only an engine capability can play: IEUM WAVE (native) and the Rust vintage instruments. */
const hostedKind = (track: Track) => !track.pluginInstrument && (instrumentDef(track.instrument).kind === 'native' || instrumentDef(track.instrument).kind === 'vintage')

/** Empty, disabled, muted and non-solo native tracks must not block the rest of a session. */
export function unsupportedNativeInstruments(project: Project, sourceAvailable: (track: Track) => boolean = () => false): string[] {
  if (project.masterVolume <= 0) return []
  const audible = audibleTrackIds(project.tracks)
  return project.tracks.filter(track => track.kind === 'instrument'
    && hostedKind(track) && !sourceAvailable(track) && audible.has(track.id)
    && track.volume > 0 && hasPlayableNotes(track, project.lengthBeats))
    .map(track => track.name)
}

export function assertNativeInstrumentsSupported(project: Project, sourceAvailable: (track: Track) => boolean = () => false, vintageReason = VINTAGE_ENGINE_REQUIRED): void {
  const tracks = unsupportedNativeInstruments(project, sourceAvailable)
  if (!tracks.length) return
  const kinds = new Set(project.tracks.filter(track => tracks.includes(track.name)).map(track => instrumentDef(track.instrument).kind))
  const reason = kinds.has('vintage') && !kinds.has('native') ? vintageReason : WAVETABLE_HOST_REQUIRED
  throw new Error(`${reason} 대상 트랙: ${tracks.slice(0, 4).join(', ')}${tracks.length > 4 ? '…' : ''}`)
}

/**
 * `vintage`: the browser engine's availability (garak-engine.wasm). The vintage instruments and IEUM WAVE exist only
 * in that module.
 */
const webSource = (vintage?: VintageBridge) => (track: Track) => (instrumentDef(track.instrument).kind === 'vintage' || track.instrument === 'wavetable') && vintage?.available() === true

export function unsupportedWebAudioInstruments(project: Project, vintage?: VintageBridge): string[] {
  return unsupportedNativeInstruments(project, webSource(vintage))
}

export function assertWebAudioProjectSupported(project: Project, vintage?: VintageBridge): void {
  assertNativeInstrumentsSupported(project, webSource(vintage), vintage?.reason() || VINTAGE_ENGINE_REQUIRED)
}
