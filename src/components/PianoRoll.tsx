import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import type { InstrumentId, MidiClip, MidiNote } from '../core/types'
import { crossedDragThreshold, isShortcutSuppressed, isUnmodified, snapDragDelta } from '../core/input'
import './PianoRoll.css'

interface PianoRollProps {
  clip: MidiClip
  color: string
  instrument: InstrumentId
  onChange: (clip: MidiClip) => void
  onPreview: (pitch: number) => void
}

type NoteGesture = {
  mode: 'move' | 'resize'
  original: MidiNote
  draft: MidiNote
  pointerId: number
  target: HTMLElement
  x: number
  y: number
  scrollLeft: number
  scrollTop: number
  activated: boolean
}

const SNAP = 0.25
const ROW_HEIGHT = 19
const RULER_HEIGHT = 24
const KEY_WIDTH = 70
const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const DRUM_NAMES: Record<number, string> = {
  35: 'LOW KICK', 36: 'KICK', 37: 'RIM', 38: 'SNARE', 39: 'CLAP',
  41: 'LOW TOM', 42: 'CLOSED HAT', 43: 'MID TOM', 45: 'HIGH TOM',
  46: 'OPEN HAT', 49: 'CRASH', 51: 'RIDE',
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const pitchName = (pitch: number) => `${PITCH_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12)
const sameNote = (a: MidiNote, b: MidiNote) => a.start === b.start && a.pitch === b.pitch && a.duration === b.duration && a.velocity === b.velocity

export default function PianoRoll({ clip, color, instrument, onChange, onPreview }: PianoRollProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const gestureRef = useRef<NoteGesture | null>(null)
  const emptyGridPressRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const velocityDraftRef = useRef<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(760)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState<MidiNote | null>(null)
  const [velocityDraft, setVelocityDraft] = useState<number | null>(null)
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null)

  const drumMode = instrument === 'drums'
  const pitches = useMemo(() => {
    if (drumMode) return [...new Set([...Object.keys(DRUM_NAMES).map(Number), ...clip.notes.map(note => note.pitch)])].sort((a, b) => b - a)
    const low = Math.max(0, Math.min(24, ...clip.notes.map(note => note.pitch)))
    const high = Math.min(127, Math.max(84, ...clip.notes.map(note => note.pitch)))
    return Array.from({ length: high - low + 1 }, (_, index) => high - index)
  }, [drumMode, clip.notes])
  const pitchRows = useMemo(() => new Map(pitches.map((pitch, index) => [pitch, index])), [pitches])
  const gridWidth = Math.max(clip.lengthBeats * 58, viewportWidth - KEY_WIDTH, 320)
  const beatWidth = gridWidth / Math.max(SNAP, clip.lengthBeats)
  const selectedNote = clip.notes.find(note => note.id === selectedId) ?? null
  const activeNote = draftNote ?? selectedNote
  const velocity = velocityDraft ?? selectedNote?.velocity ?? 0.8
  const velocityValue = Math.round(clamp(velocity, 1 / 127, 1) * 127)

  function cancelGesture(render = true) {
    const gesture = gestureRef.current
    gestureRef.current = null
    emptyGridPressRef.current = null
    if (gesture) {
      delete gesture.target.dataset.dawGesture
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId)
    }
    if (render) setDraftNote(null)
  }

  function cancelVelocity(render = true) {
    velocityDraftRef.current = null
    if (render) setVelocityDraft(null)
  }

  useEffect(() => {
    const blur = () => { cancelGesture(); cancelVelocity() }
    const visibility = () => { if (document.hidden) blur() }
    const escape = (event: globalThis.KeyboardEvent) => {
      if ((!gestureRef.current && velocityDraftRef.current === null) || event.key !== 'Escape'
        || !isUnmodified(event) || isShortcutSuppressed(event)) return
      event.preventDefault()
      event.stopPropagation()
      cancelGesture()
      cancelVelocity()
    }
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', escape, true)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('visibilitychange', visibility)
      cancelGesture(false)
      cancelVelocity(false)
    }
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setViewportWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    cancelGesture()
    setSelectedId(null)
    setDraftNote(null)
    setVelocityDraft(null)
    velocityDraftRef.current = null
    gestureRef.current = null
    emptyGridPressRef.current = null
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current
      if (!scroll) return
      const notes = clip.notes
      const centerPitch = notes.length ? notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length : drumMode ? 42 : 60
      const nearestRow = pitches.reduce((best, pitch, index) => Math.abs(pitch - centerPitch) < Math.abs(pitches[best] - centerPitch) ? index : best, 0)
      scroll.scrollTop = Math.max(0, nearestRow * ROW_HEIGHT - (scroll.clientHeight - RULER_HEIGHT) / 2 + ROW_HEIGHT / 2)
      scroll.scrollLeft = 0
    })
    return () => cancelAnimationFrame(frame)
    // A clip's scroll position is preserved while editing its notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, drumMode])

  useEffect(() => {
    setVelocityDraft(null)
    velocityDraftRef.current = null
  }, [selectedId])

  useEffect(() => {
    if (selectedId && !clip.notes.some(note => note.id === selectedId)) setSelectedId(null)
  }, [clip.notes, selectedId])

  const labelForPitch = (pitch: number) => drumMode ? DRUM_NAMES[pitch] ?? pitchName(pitch) : pitchName(pitch)

  function replaceNote(note: MidiNote) {
    onChange({ ...clip, notes: clip.notes.map(item => item.id === note.id ? note : item) })
  }

  function deleteNote(id: string) {
    cancelGesture()
    cancelVelocity()
    // Keep keyboard focus in the editor after removing its focused note.
    // A held Delete must never fall back to a region or track command.
    rootRef.current?.focus({ preventScroll: true })
    onChange({ ...clip, notes: clip.notes.filter(note => note.id !== id) })
    if (selectedId === id) setSelectedId(null)
  }

  function beginGesture(event: PointerEvent<HTMLElement>, note: MidiNote, mode: NoteGesture['mode']) {
    if (event.button !== 0) return
    cancelGesture()
    emptyGridPressRef.current = null
    event.preventDefault()
    event.stopPropagation()
    const focusTarget = event.currentTarget.closest('button') ?? event.currentTarget
    focusTarget.focus({ preventScroll: true })
    setSelectedId(note.id)
    setVelocityDraft(null)
    velocityDraftRef.current = null
    if (mode === 'move') onPreview(note.pitch)
    const target = focusTarget as HTMLElement
    target.dataset.dawGesture = `note-${mode}`
    gestureRef.current = {
      mode, original: { ...note }, draft: { ...note }, pointerId: event.pointerId,
      target, x: event.clientX, y: event.clientY, activated: false,
      scrollLeft: scrollRef.current?.scrollLeft ?? 0,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    }
    try { target.setPointerCapture(event.pointerId) } catch { cancelGesture() }
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const dx = event.clientX - gesture.x + (scrollRef.current?.scrollLeft ?? 0) - gesture.scrollLeft
    const dy = event.clientY - gesture.y + (scrollRef.current?.scrollTop ?? 0) - gesture.scrollTop
    if (!gesture.activated && !crossedDragThreshold(dx, gesture.mode === 'resize' ? 0 : dy)) return
    gesture.activated = true
    const next = { ...gesture.original }
    if (gesture.mode === 'resize') {
      next.duration = clamp(gesture.original.duration + snapDragDelta(dx / beatWidth, SNAP), SNAP, Math.max(SNAP, clip.lengthBeats - next.start))
    } else {
      next.start = clamp(gesture.original.start + snapDragDelta(dx / beatWidth, SNAP), 0, Math.max(0, clip.lengthBeats - next.duration))
      const originalRow = pitchRows.get(gesture.original.pitch) ?? 0
      next.pitch = pitches[clamp(originalRow + Math.round(dy / ROW_HEIGHT), 0, pitches.length - 1)]
    }
    gesture.draft = next
    setDraftNote(next)
  }

  function endGesture(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.stopPropagation()
    gestureRef.current = null
    delete gesture.target.dataset.dawGesture
    if (gesture.target.hasPointerCapture(event.pointerId)) gesture.target.releasePointerCapture(event.pointerId)
    setDraftNote(null)
    if (commit && !sameNote(gesture.original, gesture.draft)) replaceNote(gesture.draft)
  }

  function addNote(event: MouseEvent<HTMLDivElement>) {
    const press = emptyGridPressRef.current
    emptyGridPressRef.current = null
    // Releasing pointer capture can retarget a note's trailing click to this
    // grid. Only a press that started on genuinely empty grid space may add.
    if (!press || event.target !== event.currentTarget || event.button !== 0 || gestureRef.current || !canvasRef.current) return
    if (Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4
      || Math.abs((scrollRef.current?.scrollLeft ?? 0) - press.scrollLeft) > 1
      || Math.abs((scrollRef.current?.scrollTop ?? 0) - press.scrollTop) > 1) return
    const rect = canvasRef.current.getBoundingClientRect()
    const beat = Math.floor(((event.clientX - rect.left) / beatWidth) / SNAP) * SNAP
    const row = clamp(Math.floor((event.clientY - rect.top) / ROW_HEIGHT), 0, pitches.length - 1)
    const start = clamp(beat, 0, Math.max(0, clip.lengthBeats - SNAP))
    const note: MidiNote = {
      id: `note-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      pitch: pitches[row], start, duration: Math.min(drumMode ? SNAP : 1, clip.lengthBeats - start), velocity: 0.8,
    }
    onChange({ ...clip, notes: [...clip.notes, note].sort((a, b) => a.start - b.start || a.pitch - b.pitch) })
    setSelectedId(note.id)
    setVelocityDraft(null)
    onPreview(note.pitch)
    rootRef.current?.focus({ preventScroll: true })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || isShortcutSuppressed(event.nativeEvent, true)) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input,textarea,select,[contenteditable],[role="textbox"],[role="slider"]')
      || (target?.closest('button') && !target.closest('.piano-note'))) return
    if (event.key === 'Escape' && isUnmodified(event.nativeEvent)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const gesture = gestureRef.current
      if (gesture) {
        cancelGesture()
      } else {
        setSelectedId(null)
      }
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && isUnmodified(event.nativeEvent)) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat && !gestureRef.current && selectedNote) deleteNote(selectedNote.id)
      return
    }
    if (gestureRef.current || !selectedNote) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !isUnmodified(event.nativeEvent, true)) return
    event.preventDefault()
    event.stopPropagation()
    const next = { ...selectedNote }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = event.key === 'ArrowLeft' ? -SNAP : SNAP
      if (event.shiftKey) next.duration = clamp(next.duration + step, SNAP, Math.max(SNAP, clip.lengthBeats - next.start))
      else next.start = clamp(next.start + step, 0, Math.max(0, clip.lengthBeats - next.duration))
    } else if (drumMode) {
      const row = pitchRows.get(next.pitch) ?? 0
      next.pitch = pitches[clamp(row + (event.key === 'ArrowUp' ? -1 : 1), 0, pitches.length - 1)]
    } else {
      next.pitch = clamp(next.pitch + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1), 0, 127)
    }
    if (!sameNote(next, selectedNote)) {
      replaceNote(next)
      if (next.pitch !== selectedNote.pitch) onPreview(next.pitch)
    }
  }

  function commitVelocity(value: number) {
    if (!selectedNote || velocityDraftRef.current === null) return
    const nextVelocity = clamp(value / 127, 1 / 127, 1)
    velocityDraftRef.current = null
    setVelocityDraft(null)
    if (Math.abs(nextVelocity - selectedNote.velocity) > 0.0001) replaceNote({ ...selectedNote, velocity: nextVelocity })
  }

  const style = {
    '--piano-color': color,
    '--piano-row': `${ROW_HEIGHT}px`,
    '--piano-step': `${beatWidth * SNAP}px`,
    '--piano-beat': `${beatWidth}px`,
    '--piano-bar': `${beatWidth * 4}px`,
  } as CSSProperties

  return (
    <section className={`piano-roll${drumMode ? ' piano-roll--drums' : ''}`} style={style} ref={rootRef} tabIndex={0} data-keyboard-scope="piano" onKeyDown={handleKeyDown} aria-label="피아노롤 음표 편집기">
      <header className="piano-header">
        <div className="piano-heading">
          <span className="piano-keyboard-icon" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>{drumMode ? '드럼 에디터' : '피아노롤'}</strong>
          <span className="piano-header-divider" />
          <span className="piano-clip-name" title={clip.name}>{clip.name}</span>
        </div>
        <div className="piano-header-right">
          {activeNote && <span className="piano-selection-label">{labelForPitch(activeNote.pitch)} <span>· {activeNote.duration.toFixed(2).replace(/\.00$/, '')}박</span></span>}
          <span className="piano-snap" title="16분음표 단위로 이동하고 편집합니다"><span aria-hidden="true">▦</span> 1/16</span>
        </div>
      </header>

      <div className="piano-scroll" ref={scrollRef}>
        <div className="piano-content" style={{ width: gridWidth + KEY_WIDTH, height: pitches.length * ROW_HEIGHT + RULER_HEIGHT }}>
          <div className="piano-ruler" style={{ height: RULER_HEIGHT }}>
            <div className="piano-ruler-corner" style={{ width: KEY_WIDTH }}>NOTE</div>
            <div className="piano-ruler-beats" style={{ width: gridWidth }}>
              {Array.from({ length: Math.ceil(clip.lengthBeats) }, (_, beat) => <span key={beat} className={`piano-ruler-mark${beat % 4 === 0 ? ' piano-ruler-mark--bar' : ''}`} style={{ left: beat * beatWidth }}>{beat % 4 === 0 ? `${Math.floor(beat / 4) + 1}` : `${Math.floor(beat / 4) + 1}.${beat % 4 + 1}`}</span>)}
            </div>
          </div>

          <div className="piano-body">
            <div className="piano-keys" style={{ width: KEY_WIDTH }}>
              {pitches.map(pitch => <button
                type="button" key={pitch}
                className={`piano-key${!drumMode && isBlackKey(pitch) ? ' piano-key--black' : ''}${pitch % 12 === 0 ? ' piano-key--octave' : ''}${hoveredPitch === pitch || draftNote?.pitch === pitch ? ' piano-key--active' : ''}`}
                style={{ height: ROW_HEIGHT }}
                onClick={event => { event.stopPropagation(); onPreview(pitch) }}
                onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
                title={`${labelForPitch(pitch)} 미리 듣기`}
                aria-label={`${labelForPitch(pitch)} 미리 듣기`}
              ><span>{drumMode ? labelForPitch(pitch) : pitch % 12 === 0 || isBlackKey(pitch) ? pitchName(pitch) : PITCH_NAMES[pitch % 12]}</span>{drumMode && <small>{pitch}</small>}</button>)}
            </div>

            <div className="piano-grid" ref={canvasRef} style={{ width: gridWidth, height: pitches.length * ROW_HEIGHT }}
              onPointerDown={event => {
                if (event.button === 0 && event.target === event.currentTarget) rootRef.current?.focus({ preventScroll: true })
                emptyGridPressRef.current = event.button === 0 && event.target === event.currentTarget
                  ? { x: event.clientX, y: event.clientY, scrollLeft: scrollRef.current?.scrollLeft ?? 0, scrollTop: scrollRef.current?.scrollTop ?? 0 }
                  : null
              }}
              onClick={addNote}
              onPointerMove={moveGesture}
              onPointerUp={event => { moveGesture(event); endGesture(event, true) }}
              onPointerCancel={event => { emptyGridPressRef.current = null; endGesture(event, false) }}
              onLostPointerCapture={event => endGesture(event, false)}
              onContextMenu={event => event.preventDefault()}
              aria-label="빈칸을 클릭해 음표 추가. 음표를 드래그해 이동하고 오른쪽 끝을 드래그해 길이를 변경합니다."
            >
              <div className="piano-grid-rows" aria-hidden="true">
                {pitches.map(pitch => <div key={pitch} className={`piano-grid-row${!drumMode && isBlackKey(pitch) ? ' piano-grid-row--black' : ''}${pitch % 12 === 0 ? ' piano-grid-row--octave' : ''}`} style={{ height: ROW_HEIGHT }} />)}
              </div>
              {clip.notes.map(original => {
                const note = draftNote?.id === original.id ? draftNote : original
                const row = pitchRows.get(note.pitch)
                if (row === undefined) return null
                const selected = note.id === selectedId
                const width = Math.max(7, Math.min(note.duration, clip.lengthBeats - note.start) * beatWidth - 2)
                const noteVelocity = selected && velocityDraft !== null ? velocityDraft : note.velocity
                return <button
                  type="button" key={note.id}
                  className={`piano-note${selected ? ' piano-note--selected' : ''}${draftNote?.id === note.id ? ' piano-note--dragging' : ''}`}
                  style={{ left: note.start * beatWidth + 1, top: row * ROW_HEIGHT + 2, width, height: ROW_HEIGHT - 4, '--note-velocity': clamp(noteVelocity, 0.1, 1) } as CSSProperties}
                  onFocus={() => setSelectedId(note.id)}
                  onPointerDown={event => beginGesture(event, original, 'move')}
                  onMouseEnter={() => setHoveredPitch(note.pitch)}
                  onMouseLeave={() => setHoveredPitch(null)}
                  onClick={event => { event.stopPropagation(); emptyGridPressRef.current = null; setSelectedId(note.id); if (event.detail === 0) onPreview(note.pitch) }}
                  onContextMenu={event => { event.preventDefault(); event.stopPropagation(); deleteNote(note.id) }}
                  onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
                  aria-label={`${labelForPitch(note.pitch)}, ${note.start + 1}박 위치, 길이 ${note.duration}박, 세기 ${Math.round(noteVelocity * 127)}`}
                  aria-pressed={selected}
                  title={`${labelForPitch(note.pitch)} · 드래그하여 이동 · 오른쪽 끝으로 길이 조절 · 우클릭으로 삭제`}
                >
                  {width > 34 && <span className="piano-note-label">{drumMode ? DRUM_NAMES[note.pitch]?.replace('CLOSED HAT', 'CH').replace('OPEN HAT', 'OH') ?? pitchName(note.pitch) : pitchName(note.pitch)}</span>}
                  <span className="piano-note-velocity" aria-hidden="true" />
                  <span className="piano-note-resize" onPointerDown={event => beginGesture(event, original, 'resize')} title="드래그하여 음표 길이 조절" aria-hidden="true" />
                </button>
              })}
            </div>
          </div>
        </div>
      </div>

      <footer className="piano-footer">
        <label className={`piano-velocity-control${selectedNote ? '' : ' piano-velocity-control--disabled'}`}>
          <span className="piano-velocity-label">VELOCITY</span>
          <input type="range" min={1} max={127} step={1} value={velocityValue} disabled={!selectedNote}
            aria-label="선택한 음표의 세기" aria-valuetext={`${velocityValue} / 127`}
            onChange={event => { velocityDraftRef.current = Number(event.currentTarget.value) / 127; setVelocityDraft(velocityDraftRef.current) }}
            onPointerUp={event => commitVelocity(Number(event.currentTarget.value))}
            onPointerCancel={() => cancelVelocity()}
            onKeyDown={event => event.stopPropagation()}
            onKeyUp={event => { event.stopPropagation(); if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitVelocity(Number(event.currentTarget.value)) }}
            onBlur={event => { if (document.hasFocus()) commitVelocity(Number(event.currentTarget.value)); else cancelVelocity() }}
            title={selectedNote ? '음표의 연주 세기 조절' : '음표를 선택해 세기를 조절하세요'}
          />
          <output>{selectedNote ? velocityValue : '—'}</output>
        </label>
        <span className="piano-help">클릭 추가 <span>·</span> 드래그 이동 <span>·</span> 우클릭 삭제</span>
        <span className="piano-note-count">{clip.notes.length}<span> NOTES</span></span>
      </footer>
    </section>
  )
}
