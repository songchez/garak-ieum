import { useEffect, useRef, useState } from 'react'
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const black = (note: number) => [1, 3, 6, 8, 10].includes(note % 12)
export function SynthKeyboard({ ready, connected, onNoteOn, onNoteOff }: { ready: boolean; connected: boolean; onNoteOn?: (note: number, velocity: number) => void; onNoteOff?: (note: number) => void }) {
  const [octave, setOctave] = useState(3), [active, setActive] = useState<number[]>([])
  const down = useRef(new Set<number>()), pointers = useRef(new Map<number, number>()), keyDown = useRef(new Set<number>())
  const latest = useRef({ onNoteOn, onNoteOff }); latest.current = { onNoteOn, onNoteOff }
  const enabled = ready && !!onNoteOn && !!onNoteOff
  // Match the DAW/Logic convention: middle C (MIDI 60) is C3.
  const first = octave * 12 + 24, notes = Array.from({ length: 25 }, (_, i) => first + i), whites = notes.filter(note => !black(note))
  const stop = () => { for (const note of down.current) latest.current.onNoteOff?.(note); down.current.clear(); pointers.current.clear(); keyDown.current.clear(); setActive([]) }
  // A new patch temporarily gates note-on, but a held note must keep sounding.
  useEffect(() => { if (!connected) stop() }, [connected])
  useEffect(() => {
    const pointerEnd = (event: PointerEvent) => releasePointer(event.pointerId)
    window.addEventListener('blur', stop); window.addEventListener('pointerup', pointerEnd); window.addEventListener('pointercancel', pointerEnd)
    return () => { window.removeEventListener('blur', stop); window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerEnd); for (const note of down.current) latest.current.onNoteOff?.(note); down.current.clear(); pointers.current.clear(); keyDown.current.clear() }
  }, [])
  function start(note: number) { if (!enabled || down.current.has(note)) return; down.current.add(note); setActive([...down.current]); latest.current.onNoteOn?.(note, .78) }
  function release(note: number) { if (!down.current.has(note)) return; down.current.delete(note); setActive([...down.current]); latest.current.onNoteOff?.(note) }
  function pointerHeld(note: number) { return [...pointers.current.values()].includes(note) }
  function releasePointer(id: number) { const note = pointers.current.get(id); pointers.current.delete(id); if (note !== undefined && !pointerHeld(note) && !keyDown.current.has(note)) release(note) }
  function releaseKey(note: number) { keyDown.current.delete(note); if (!pointerHeld(note)) release(note) }
  return <div className="iw-keyboard-area"><div className="iw-keyboard-octave"><button disabled={octave <= 0} onClick={() => { stop(); setOctave(octave - 1) }} aria-label="키보드 한 옥타브 내리기">−</button><span>C{octave}</span><button disabled={octave >= 6} onClick={() => { stop(); setOctave(octave + 1) }} aria-label="키보드 한 옥타브 올리기">+</button></div><div className={`iw-keyboard${enabled ? '' : ' is-unavailable'}`} role="group" aria-label={enabled ? '이음 웨이브 미리 듣기 키보드' : '네이티브 엔진 연결 후 사용할 수 있는 키보드'}>{notes.map(note => {
    const isBlack = black(note), whiteIndex = isBlack ? whites.filter(n => n < note).length - .32 : whites.indexOf(note), width = isBlack ? .64 : 1
    return <button key={note} disabled={!enabled && !active.includes(note)} className={`${isBlack ? 'iw-key-black' : 'iw-key-white'}${active.includes(note) ? ' is-playing' : ''}`} style={{ left: `${whiteIndex / whites.length * 100}%`, width: `${width / whites.length * 100}%` }} aria-label={`${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 2} 미리 듣기`} title={enabled ? `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 2}` : '네이티브 오디오 엔진 연결 준비 중'} onPointerDown={event => { if (event.button !== 0 || !enabled) return; event.preventDefault(); pointers.current.set(event.pointerId, note); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); start(note) }} onPointerUp={event => releasePointer(event.pointerId)} onPointerCancel={event => releasePointer(event.pointerId)} onLostPointerCapture={event => releasePointer(event.pointerId)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (enabled) { keyDown.current.add(note); start(note) } } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); releaseKey(note) } }} onBlur={() => releaseKey(note)}>{note % 12 === 0 && <span>C{Math.floor(note / 12) - 2}</span>}</button>
  })}</div><span className="iw-keyboard-status">{enabled ? '키를 눌러 연주' : '미리 듣기 대기'}</span></div>
}
