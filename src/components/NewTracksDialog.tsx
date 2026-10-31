import { useEffect, useRef, useState } from 'react'
import type { InstrumentId } from '../core/types'
import { Icon } from './Icon'
import { InstrumentOptions } from './InstrumentOptions'
import './Inspector.css'

export interface NewTracksOptions { kind: 'instrument' | 'audio'; instrument?: InstrumentId; count: number; openLibrary: boolean }

export interface NewTracksDialogProps {
  focusedKind: 'instrument' | 'audio' | undefined
  /** Default patch for new instrument tracks (the focused track's); 'keys' when absent. */
  focusedInstrument?: InstrumentId
  onCreate: (opts: NewTracksOptions) => void
  onClose: () => void
}

export const MAX_NEW_TRACKS = 16

export function NewTracksDialog({ focusedKind, focusedInstrument, onCreate, onClose }: NewTracksDialogProps) {
  const [kind, setKind] = useState<'instrument' | 'audio'>(focusedKind ?? 'instrument')
  const [instrument, setInstrument] = useState<InstrumentId>(focusedInstrument ?? 'keys')
  const [count, setCount] = useState(1)
  const [openLibrary, setOpenLibrary] = useState(true)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const clampCount = (n: number) => Math.max(1, Math.min(MAX_NEW_TRACKS, Math.round(n) || 1))
  const create = () => onCreate({ kind, instrument: kind === 'instrument' ? instrument : undefined, count: clampCount(count), openLibrary: kind === 'instrument' && openLibrary })
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="modal new-tracks" role="dialog" aria-modal="true" aria-labelledby="new-tracks-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); create() } }}>
      <button type="button" className="modal-close icon-button" onClick={onClose} aria-label="창 닫기"><Icon name="close" /></button>
      <h2 id="new-tracks-title">새 트랙</h2>
      <div className="new-tracks-types" role="radiogroup" aria-label="트랙 유형">
        <button ref={first} type="button" role="radio" aria-checked={kind === 'instrument'} className={kind === 'instrument' ? 'active' : ''} onClick={() => setKind('instrument')}><Icon name="keys" size={26} /><strong>MIDI</strong><span>소프트웨어 악기</span></button>
        <button type="button" role="radio" aria-checked={kind === 'audio'} className={kind === 'audio' ? 'active' : ''} onClick={() => setKind('audio')}><Icon name="wave" size={26} /><strong>오디오</strong><span>마이크 · 가져온 파일</span></button>
      </div>
      <div className="new-tracks-details">
        {kind === 'instrument' && <label className="new-tracks-row"><span>악기</span><select className="insp-select" value={instrument} onChange={e => setInstrument(e.target.value)}><InstrumentOptions /></select></label>}
        <label className="new-tracks-row"><span>생성할 트랙 수</span><input className="new-tracks-count" type="number" min={1} max={MAX_NEW_TRACKS} value={count} onChange={e => setCount(Number(e.target.value))} onBlur={() => setCount(c => clampCount(c))} /></label>
        {kind === 'instrument' && <label className="new-tracks-row new-tracks-check"><input type="checkbox" checked={openLibrary} onChange={e => setOpenLibrary(e.target.checked)} /><span>라이브러리 열기</span></label>}
      </div>
      <div className="modal-buttons"><button type="button" onClick={onClose}>취소</button><button type="button" className="primary" onClick={create}>생성</button></div>
    </section>
  </div>
}
