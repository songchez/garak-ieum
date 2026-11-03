import type { RecordingDraft, RecordingDraftPlacement } from '../core/recording'
import { musicalSpan } from '../core/musicalGrid'
import './RecordingRegion.css'

export function formatRecordingElapsed(seconds:number):string {
  const tenths=Math.floor(Math.max(0,seconds)*10)
  return `${Math.floor(tenths/600)}:${String(Math.floor(tenths/10)%60).padStart(2,'0')}.${tenths%10}`
}

/** A display-only take. Its width is captured time; no samples are invented. */
export function RecordingRegion({draft,placement,ppb}:{draft:RecordingDraft;placement:RecordingDraftPlacement;ppb:number}){
  const processing=draft.status==='processing'
  const status=processing?'녹음 처리 중':'녹음 중'
  const elapsed=formatRecordingElapsed(placement.elapsedSeconds)
  return <div
    className={`recording-region ${processing?'recording-region--processing':''}`}
    data-recording-id={draft.id}
    style={musicalSpan(placement.startBeat,placement.lengthBeats,ppb)}
    role="img"
    aria-label={`${draft.name} · ${status} · ${elapsed}`}
  >
    <div className="recording-region-label" aria-hidden="true"><i className="recording-indicator"/><strong>{status}</strong><span>{draft.name}</span><time>{elapsed}</time></div>
  </div>
}
