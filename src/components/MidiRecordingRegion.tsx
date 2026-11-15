import type { MidiRecordingPreview } from './useMidiPerformance'
import { musicalSpan } from '../core/musicalGrid'
import './RecordingRegion.css'

/** The growing region of a MIDI take: recorded and held notes drawn live (docs/MIDI_RECORDING.md). */
export function MidiRecordingRegion({ take, ppb }: { take: MidiRecordingPreview; ppb: number }) {
  const length = Math.max(1 / 16, take.endBeat - take.startBeat)
  const pitches = take.notes.map(note => note.pitch)
  const low = pitches.length ? Math.min(...pitches) - 1 : 59, high = pitches.length ? Math.max(...pitches) + 1 : 61
  const rows = Math.max(1, high - low)
  return <div className="recording-region recording-region--midi" data-midi-recording={take.trackId} style={musicalSpan(take.startBeat, length, ppb)} role="img" aria-label={`MIDI 녹음 중 · 음표 ${take.notes.length}개`}>
    <div className="recording-region-label" aria-hidden="true"><i className="recording-indicator" /><strong>MIDI 녹음 중</strong><time>{take.notes.length}음</time></div>
    <div className="midi-recording-notes" aria-hidden="true">
      {take.notes.map((note, index) => <i key={index} style={{ left: `${(note.start - take.startBeat) / length * 100}%`, width: `${Math.max(0.3, (note.end - note.start) / length * 100)}%`, top: `${(high - note.pitch - 0.5) / rows * 100}%`, opacity: 0.55 + note.velocity * 0.45 }} />)}
    </div>
  </div>
}
