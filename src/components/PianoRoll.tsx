import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, RefObject } from 'react'
import type { InstrumentId, MidiClip, MidiNote } from '../core/types'
import { crossedDragThreshold, dragModifiers, isShortcutSuppressed, isUnmodified, shortcutPlatform, snapDragDelta, type ProjectShortcut } from '../core/input'
import { GM_KIT_NAMES, instrumentDef } from '../core/instruments'
import { pitchClassName, pitchName } from '../core/pitch'
import { contrastTextColor } from '../core/colors'
import { applyMidiNoteEdits, midiEditorClip } from '../core/midiRegions'
import { musicalGrid, musicalGridStyle, musicalRulerMarks, musicalSpan } from '../core/musicalGrid'
import { snapToEdges } from '../core/edgeSnap'
import { editNoteTiming, noteTimingBounds, pianoNoteStart, MIN_PIANO_NOTE_LENGTH as MIN_LENGTH } from '../core/pianoEditing'
import { ZOOM_KEY_FACTOR, ZOOM_KEY_FACTOR_V, ZOOM_LIMITS, clampZoom, fitScale, zoomBy, type ZoomCommand, type ZoomHandle, type ZoomState } from '../core/zoom'
import ContextMenu from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
import { ZoomControls } from './ZoomControls'
import './PianoRoll.css'

type PianoZoom = ZoomState['piano']

interface PianoRollProps {
  clip: MidiClip
  color: string
  instrument: InstrumentId
  onChange: (clip: MidiClip) => void
  onPreview: (pitch: number) => void
  /** Absolute project beat of the transport. The playhead is hidden when undefined. */
  playheadBeat?: number
  /** Optional mouse snap in beats. Omitted/0 means free placement; arrows use the visible grid. */
  snap?: number
  onSnapChange?: (snap: number) => void
  /** Horizontal ppb (null = fit the clip) and row height. Internal state is used when omitted. */
  zoom?: PianoZoom
  onZoomChange?: (zoom: PianoZoom) => void
  zoomRef?: RefObject<ZoomHandle | null>
  commandRef?: RefObject<((command: ProjectShortcut) => boolean) | null>
}

type Press = { pointerId: number; target: HTMLElement; originX: number; originY: number; activated: boolean; prevSelection: Set<string> }
type NoteGesture = Press & {
  kind: 'note'; mode: 'move' | 'resize' | 'resize-left'; anchorId: string; originals: MidiNote[]
  copyIds: string[] | null; axis: 'x' | 'y' | null; pending: 'collapse' | 'toggle' | null; lastPitch: number; moved: MidiNote[] | null
}
type MarqueeGesture = Press & { kind: 'marquee'; base: Set<string>; plainClick: boolean }
type VelocityGesture = Press & { kind: 'velocity'; anchorId: string; originals: MidiNote[]; pending: 'collapse' | null; moved: MidiNote[] | null }
type Gesture = NoteGesture | MarqueeGesture | VelocityGesture
type MenuState = { x: number; y: number; kind: 'note' | 'grid'; beat?: number }

const SNAP_OPTIONS: [string, number][] = [['자유 이동', 0], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/64', 0.0625], ['1/4T', 2 / 3], ['1/8T', 1 / 3], ['1/16T', 1 / 6]]
const ROW_HEIGHT = 19
const COMPACT_ROW = 13
const RULER_HEIGHT = 24
const KEY_WIDTH = 70
const LANE_HEIGHT = 52
const LANE_RANGE = LANE_HEIGHT - 12
const MIN_VELOCITY = 1 / 127

// Shared between clips so notes can be copied from one region to another.
let noteClipboard: MidiNote[] = []

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12)
const byTime = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch
const sameNote = (a: MidiNote, b: MidiNote) => a.start === b.start && a.pitch === b.pitch && a.duration === b.duration && a.velocity === b.velocity
const newId = () => `note-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

export default function PianoRoll({ clip: sourceClip, color, instrument, onChange, onPreview, playheadBeat, snap: snapProp, onSnapChange, zoom: zoomProp, onZoomChange, zoomRef, commandRef }: PianoRollProps) {
  const clip = useMemo(() => midiEditorClip(sourceClip), [sourceClip])
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const sliderDraftRef = useRef<number | null>(null)
  const lastRef = useRef({ chromatic: 1, drum: 0.25, velocity: 0.8 })
  const anchorRef = useRef<string | null>(null)
  const pendingFocusRef = useRef<string | null>(null)
  const pointerFocusRef = useRef(false)
  const [viewport, setViewport] = useState({ width: 760, height: 300, left: 0 })
  const viewportWidth = viewport.width
  const [zoomState, setZoomState] = useState<PianoZoom>({ ppb: null, rowHeight: ROW_HEIGHT })
  const zoom = zoomProp ?? zoomState
  const zoomAnchorRef = useRef<{ x?: { beat: number; px: number }; y?: { row: number; py: number } }>({})
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<MidiNote[] | null>(null)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [alignmentBeat, setAlignmentBeat] = useState<number | null>(null)
  const [sliderDraft, setSliderDraft] = useState<number | null>(null)
  const [hoveredPitch, setHoveredPitch] = useState<number | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [showVelocity, setShowVelocity] = useState(true)
  const [snapState, setSnapState] = useState(0)
  const snap = snapProp ?? snapState
  const previousSnap = useRef(.25)
  if (snap > 0) previousSnap.current = snap

  const def = instrumentDef(instrument)
  const drumMode = def.isKit
  const DRUM_NAMES = def.padNames ?? GM_KIT_NAMES
  const pitches = useMemo(() => {
    if (drumMode) return [...new Set([...Object.keys(DRUM_NAMES).map(Number), ...clip.notes.map(note => note.pitch)])].sort((a, b) => b - a)
    const low = Math.max(0, Math.min(24, ...clip.notes.map(note => note.pitch)))
    const high = Math.min(127, Math.max(84, ...clip.notes.map(note => note.pitch)))
    return Array.from({ length: high - low + 1 }, (_, index) => high - index)
  }, [drumMode, DRUM_NAMES, clip.notes])
  const pitchRows = useMemo(() => new Map(pitches.map((pitch, index) => [pitch, index])), [pitches])
  const ROW = Math.round(clampZoom(zoom.rowHeight, ZOOM_LIMITS.pianoY))
  const clipBeats = Math.max(0.25, clip.lengthBeats)
  const fitPpb = fitScale(clipBeats, Math.max(120, viewportWidth - KEY_WIDTH - 1), ZOOM_LIMITS.pianoX)
  const beatWidth = zoom.ppb === null ? fitPpb : clampZoom(zoom.ppb, ZOOM_LIMITS.pianoX)
  const grid = musicalGrid(beatWidth, { snap })
  const gridWidth = clipBeats * beatWidth
  const notes = draft ?? clip.notes
  const clipNotesById = useMemo(() => new Map(clip.notes.map(note => [note.id, note])), [clip.notes])
  const selectedNotes = notes.filter(note => selectedIds.has(note.id))
  const primaryNote = selectedNotes.length === 1 ? selectedNotes[0] : null
  const draggingPitches = draft ? new Set(selectedNotes.map(note => note.pitch)) : null
  const velocity = sliderDraft ?? selectedNotes[0]?.velocity ?? lastRef.current.velocity
  const velocityValue = Math.round(clamp(velocity, MIN_VELOCITY, 1) * 127)
  const localPlayhead = playheadBeat === undefined ? null : playheadBeat - clip.startBeat
  const showPlayhead = localPlayhead !== null && localPlayhead >= 0 && localPlayhead <= clip.lengthBeats
  const mac = shortcutPlatform() === 'mac'
  const modLabel = mac ? '⌘' : 'Ctrl+'
  const altLabel = mac ? '⌥' : 'Alt+'

  function setSnap(value: number) {
    setSnapState(value)
    onSnapChange?.(value)
  }

  function cancelGesture(render = true) {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (gesture) {
      delete gesture.target.dataset.dawGesture
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId)
      if (render && gesture.activated && (gesture.kind === 'marquee' || (gesture.kind === 'note' && gesture.copyIds))) setSelectedIds(gesture.prevSelection)
    }
    if (render) { setDraft(null); setMarquee(null); setAlignmentBeat(null) }
  }

  function cancelSlider(render = true) {
    sliderDraftRef.current = null
    if (render) setSliderDraft(null)
  }

  useEffect(() => {
    const blur = () => { cancelGesture(); cancelSlider() }
    const visibility = () => { if (document.hidden) blur() }
    const escape = (event: globalThis.KeyboardEvent) => {
      if ((!gestureRef.current && sliderDraftRef.current === null) || event.key !== 'Escape'
        || !isUnmodified(event) || isShortcutSuppressed(event)) return
      event.preventDefault()
      event.stopPropagation()
      cancelGesture()
      cancelSlider()
    }
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', escape, true)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('visibilitychange', visibility)
      cancelGesture(false)
      cancelSlider(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight, left: element.scrollLeft })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    cancelGesture()
    cancelSlider()
    setSelectedIds(new Set())
    setMenu(null)
    anchorRef.current = null
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current
      if (!scroll) return
      const notes = clip.notes
      const centerPitch = notes.length ? notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length : drumMode ? 42 : 60
      const nearestRow = pitches.reduce((best, pitch, index) => Math.abs(pitch - centerPitch) < Math.abs(pitches[best] - centerPitch) ? index : best, 0)
      scroll.scrollTop = Math.max(0, nearestRow * ROW - (scroll.clientHeight - RULER_HEIGHT) / 2 + ROW / 2)
      scroll.scrollLeft = 0
    })
    return () => cancelAnimationFrame(frame)
    // A clip's scroll position is preserved while editing its notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, drumMode])

  useEffect(() => {
    const id = pendingFocusRef.current
    if (!id) return
    pendingFocusRef.current = null
    const button = [...(canvasRef.current?.querySelectorAll<HTMLElement>('.piano-note') ?? [])].find(element => element.dataset.noteId === id)
    if (!button) return
    pointerFocusRef.current = true
    button.focus()
    pointerFocusRef.current = false
  })

  function setZoom(next: PianoZoom) {
    setZoomState(next)
    onZoomChange?.(next)
  }

  /** Time zoom around a viewport x (default: the left edge of the grid). */
  function zoomX(factor: number, pointerX = KEY_WIDTH) {
    const next = zoomBy(beatWidth, factor, ZOOM_LIMITS.pianoX)
    if (Math.abs(next - beatWidth) < 0.01) return
    const scroll = scrollRef.current
    const px = Math.max(KEY_WIDTH, pointerX)
    if (scroll) zoomAnchorRef.current.x = { beat: (scroll.scrollLeft + px - KEY_WIDTH) / beatWidth, px }
    setZoom({ ...zoom, ppb: next })
  }

  /** Row height zoom keeping the pitch under a viewport y (default: the middle) in place. */
  function zoomY(factor: number, pointerY?: number) {
    const next = zoomBy(zoom.rowHeight, factor, ZOOM_LIMITS.pianoY)
    if (Math.abs(next - zoom.rowHeight) < 0.01) return
    const scroll = scrollRef.current
    const py = Math.max(RULER_HEIGHT, pointerY ?? RULER_HEIGHT + ((scroll?.clientHeight ?? 0) - RULER_HEIGHT) / 2)
    if (scroll) zoomAnchorRef.current.y = { row: (scroll.scrollTop + py - RULER_HEIGHT) / ROW, py }
    setZoom({ ...zoom, rowHeight: next })
  }

  /** Z: the whole clip across the width and the used pitch range across the height. */
  function zoomToFit() {
    const scroll = scrollRef.current
    const rows = clip.notes.map(note => pitchRows.get(note.pitch)).filter((row): row is number => row !== undefined)
    const top = rows.length ? Math.min(...rows) : pitchRows.get(drumMode ? 42 : 72) ?? 0
    const bottom = rows.length ? Math.max(...rows) : pitchRows.get(drumMode ? 36 : 48) ?? pitches.length - 1
    const available = (scroll?.clientHeight ?? viewport.height) - RULER_HEIGHT - (showVelocity ? LANE_HEIGHT : 0)
    const rowHeight = Math.floor(clampZoom(available / (bottom - top + 3), ZOOM_LIMITS.pianoY))
    zoomAnchorRef.current = { x: { beat: 0, px: KEY_WIDTH }, y: { row: (top + bottom + 1) / 2, py: RULER_HEIGHT + available / 2 } }
    setZoom({ ppb: null, rowHeight })
  }

  function zoomCommand(command: ZoomCommand) {
    if (command === 'zoomToFit') zoomToFit()
    else if (command === 'zoomIn' || command === 'zoomOut') zoomX(command === 'zoomIn' ? ZOOM_KEY_FACTOR : 1 / ZOOM_KEY_FACTOR)
    else zoomY(command === 'zoomInV' ? ZOOM_KEY_FACTOR_V : 1 / ZOOM_KEY_FACTOR_V)
  }

  useZoomHandle(zoomRef, { zoom: (axis, factor) => axis === 'x' ? zoomX(factor) : zoomY(factor), fit: zoomToFit })
  useZoomWheel(scrollRef, { onZoomX: (factor, x) => zoomX(factor, x), onZoomY: (factor, y) => zoomY(factor, y) })

  // Applied after the zoomed layout renders, so the anchored beat/pitch stays under the pointer.
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const { x, y } = zoomAnchorRef.current
    zoomAnchorRef.current = {}
    if (!scroll) return
    if (x) scroll.scrollLeft = Math.max(0, x.beat * beatWidth + KEY_WIDTH - x.px)
    if (y) scroll.scrollTop = Math.max(0, y.row * ROW + RULER_HEIGHT - y.py)
  })

  const labelForPitch = (pitch: number) => drumMode ? DRUM_NAMES[pitch] ?? pitchName(pitch) : pitchName(pitch)

  function commit(next: MidiNote[]) {
    onChange(applyMidiNoteEdits(sourceClip, [...next].sort(byTime)))
  }

  function selectedFromClip() {
    return clip.notes.filter(note => selectedIds.has(note.id))
  }

  function canvasPoint(event: { clientX: number; clientY: number }) {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  function focusRoot() {
    rootRef.current?.focus({ preventScroll: true })
  }

  function selectNote(note: MidiNote, additive = false) {
    setSelectedIds(additive ? new Set([...selectedIds, note.id]) : new Set([note.id]))
    anchorRef.current = note.id
    if (rootRef.current?.contains(document.activeElement)) pendingFocusRef.current = note.id
  }

  function anchorNote(direction = 1) {
    const selected = selectedFromClip().sort(byTime)
    return selected.find(note => note.id === anchorRef.current) ?? (direction < 0 ? selected[0] : selected[selected.length - 1]) ?? null
  }

  function rememberLength(length: number) {
    lastRef.current[drumMode ? 'drum' : 'chromatic'] = length
  }

  /** Pointer selection rule shared by notes and velocity bars (Logic-style). */
  function pressSelection(note: MidiNote, shiftKey: boolean) {
    const wasSelected = selectedIds.has(note.id)
    let selection = selectedIds
    let pending: 'collapse' | 'toggle' | null = null
    if (shiftKey) {
      if (wasSelected) pending = 'toggle'
      else selection = new Set([...selectedIds, note.id])
    } else if (wasSelected) {
      if (selectedIds.size > 1) pending = 'collapse'
    } else selection = new Set([note.id])
    if (selection !== selectedIds) setSelectedIds(selection)
    anchorRef.current = note.id
    return { selection, pending }
  }

  // A macOS Ctrl-click is a secondary click; Ctrl only refines a drag once it is under way.
  const primaryPress = (event: PointerEvent<HTMLElement>) => event.button === 0 && !(mac && event.ctrlKey)

  function beginNoteGesture(event: PointerEvent<HTMLElement>, note: MidiNote, mode: NoteGesture['mode']) {
    if (!primaryPress(event)) return
    cancelGesture()
    event.preventDefault()
    event.stopPropagation()
    const target = (event.currentTarget.closest('button') ?? event.currentTarget) as HTMLElement
    pointerFocusRef.current = true
    target.focus({ preventScroll: true })
    pointerFocusRef.current = false
    cancelSlider()
    const { selection, pending } = pressSelection(note, event.shiftKey)
    if (mode === 'move') onPreview(note.pitch)
    const point = canvasPoint(event)
    target.dataset.dawGesture = `note-${mode}`
    gestureRef.current = {
      kind: 'note', mode, anchorId: note.id, originals: clip.notes.filter(item => selection.has(item.id)),
      copyIds: null, axis: null, pending, lastPitch: note.pitch, moved: null, prevSelection: selection,
      pointerId: event.pointerId, target, originX: point.x, originY: point.y, activated: false,
    }
    try { target.setPointerCapture(event.pointerId) } catch { cancelGesture() }
  }

  function moveNoteGesture(gesture: NoteGesture, event: PointerEvent<HTMLElement>) {
    const point = canvasPoint(event)
    let dx = point.x - gesture.originX
    let dy = point.y - gesture.originY
    const modifiers = dragModifiers(event)
    if (!gesture.activated) {
      if (!crossedDragThreshold(dx, gesture.mode === 'move' ? dy : 0)) return
      gesture.activated = true
      gesture.pending = null
      if (gesture.mode === 'move' && modifiers.axisLock) gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      if (gesture.mode === 'move' && modifiers.copy) {
        gesture.copyIds = gesture.originals.map(() => newId())
        setSelectedIds(new Set(gesture.copyIds))
      }
    }
    if (gesture.axis === 'x') dy = 0
    else if (gesture.axis === 'y') dx = 0
    const step = modifiers.noSnap ? 0 : modifiers.fine ? snap / 2 : snap
    let delta = snapDragDelta(dx / beatWidth, step)
    const originals = gesture.originals
    const rows = originals.map(note => pitchRows.get(note.pitch) ?? 0)
    const rowDelta = gesture.mode === 'move' ? clamp(Math.round(dy / ROW), -Math.min(...rows), pitches.length - 1 - Math.max(...rows)) : 0
    const targetPitches = new Set(rows.map(row => pitches[row + rowDelta]))
    const originalIds = new Set(originals.map(note => note.id))
    const minimumLength = Math.max(step, MIN_LENGTH)
    const { minDelta, maxDelta } = noteTimingBounds(originals, clip.lengthBeats, gesture.mode, minimumLength)
    const snapped = snapToEdges({
      rawDelta: dx / beatWidth, gridDelta: delta,
      movingEdges: originals.flatMap(note => gesture.mode === 'move' ? [note.start, note.start + note.duration] : [note.start + (gesture.mode === 'resize' ? note.duration : 0)]),
      targetEdges: clip.notes.filter(note => ((gesture.mode === 'move' && gesture.copyIds !== null) || !originalIds.has(note.id)) && targetPitches.has(note.pitch)).flatMap(note => [note.start, note.start + note.duration]),
      ppb: beatWidth, enabled: snap > 0 && !modifiers.noSnap && gesture.axis !== 'y' && (gesture.mode !== 'move' || Math.abs(dx) >= 4), minDelta, maxDelta,
    })
    delta = snapped.delta
    setAlignmentBeat(snapped.guide)
    let moved = editNoteTiming(originals, delta, clip.lengthBeats, gesture.mode, minimumLength)
    if (gesture.mode === 'move') {
      moved = moved.map((note, index) => ({ ...note, id: gesture.copyIds?.[index] ?? note.id, pitch: pitches[rows[index] + rowDelta] }))
    }
    gesture.moved = moved
    const anchorIndex = originals.findIndex(note => note.id === gesture.anchorId)
    const anchorPitch = moved[anchorIndex]?.pitch
    if (gesture.mode === 'move' && anchorPitch !== undefined && anchorPitch !== gesture.lastPitch) {
      gesture.lastPitch = anchorPitch
      onPreview(anchorPitch)
    }
    if (gesture.copyIds) setDraft([...clip.notes, ...moved])
    else {
      const byId = new Map(moved.map(note => [note.id, note]))
      setDraft(clip.notes.map(note => byId.get(note.id) ?? note))
    }
  }

  function endNoteGesture(gesture: NoteGesture, commitChange: boolean) {
    if (!gesture.activated) {
      if (!commitChange) return
      if (gesture.pending === 'collapse') setSelectedIds(new Set([gesture.anchorId]))
      if (gesture.pending === 'toggle') setSelectedIds(new Set([...gesture.prevSelection].filter(id => id !== gesture.anchorId)))
      return
    }
    const moved = gesture.moved
    const changed = !!moved && moved.some((note, index) => !sameNote(note, gesture.originals[index]))
    if (!commitChange || !moved || !changed) {
      if (gesture.copyIds) setSelectedIds(gesture.prevSelection)
      return
    }
    if (gesture.copyIds) {
      commit([...clip.notes, ...moved])
      anchorRef.current = gesture.copyIds[gesture.originals.findIndex(note => note.id === gesture.anchorId)] ?? null
    } else {
      const byId = new Map(moved.map(note => [note.id, note]))
      commit(clip.notes.map(note => byId.get(note.id) ?? note))
    }
    if (gesture.mode !== 'move') {
      const anchor = moved.find(note => note.id === gesture.anchorId)
      if (anchor) rememberLength(anchor.duration)
    }
  }

  function beginMarquee(event: PointerEvent<HTMLDivElement>) {
    if (!primaryPress(event) || event.target !== event.currentTarget) return
    cancelGesture()
    event.preventDefault()
    focusRoot()
    const point = canvasPoint(event)
    const target = event.currentTarget
    target.dataset.dawGesture = 'marquee'
    gestureRef.current = {
      kind: 'marquee', base: event.shiftKey ? selectedIds : new Set(), plainClick: !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey, prevSelection: selectedIds,
      pointerId: event.pointerId, target, originX: point.x, originY: point.y, activated: false,
    }
    try { target.setPointerCapture(event.pointerId) } catch { cancelGesture() }
  }

  function moveMarquee(gesture: MarqueeGesture, event: PointerEvent<HTMLElement>) {
    const point = canvasPoint(event)
    if (!gesture.activated && !crossedDragThreshold(point.x - gesture.originX, point.y - gesture.originY)) return
    gesture.activated = true
    const gridHeight = pitches.length * ROW
    const left = clamp(Math.min(point.x, gesture.originX), 0, gridWidth)
    const right = clamp(Math.max(point.x, gesture.originX), 0, gridWidth)
    const top = clamp(Math.min(point.y, gesture.originY), 0, gridHeight)
    const bottom = clamp(Math.max(point.y, gesture.originY), 0, gridHeight)
    setMarquee({ left, top, width: right - left, height: bottom - top })
    const hits = clip.notes.filter(note => {
      const row = pitchRows.get(note.pitch)
      if (row === undefined) return false
      return note.start * beatWidth < right && (note.start + note.duration) * beatWidth > left && row * ROW < bottom && (row + 1) * ROW > top
    })
    setSelectedIds(new Set([...gesture.base, ...hits.map(note => note.id)]))
  }

  function endMarquee(gesture: MarqueeGesture, commitChange: boolean) {
    setMarquee(null)
    if (gesture.activated) {
      if (!commitChange) setSelectedIds(gesture.prevSelection)
    } else if (commitChange && gesture.plainClick) addNoteAt(gesture.originX, gesture.originY)
  }

  function addNoteAt(x: number, y: number) {
    const row = clamp(Math.floor(y / ROW), 0, pitches.length - 1)
    const start = pianoNoteStart(x / beatWidth, clip.lengthBeats, snap)
    const length = lastRef.current[drumMode ? 'drum' : 'chromatic']
    const note: MidiNote = { id: newId(), pitch: pitches[row], start, duration: Math.min(length, clip.lengthBeats - start), velocity: lastRef.current.velocity }
    commit([...clip.notes, note])
    setSelectedIds(new Set([note.id]))
    anchorRef.current = note.id
    cancelSlider()
    onPreview(note.pitch)
    focusRoot()
  }

  function beginVelocity(event: PointerEvent<HTMLElement>, note: MidiNote) {
    if (!primaryPress(event)) return
    cancelGesture()
    event.preventDefault()
    event.stopPropagation()
    focusRoot()
    cancelSlider()
    const { selection, pending } = pressSelection(note, event.shiftKey && !selectedIds.has(note.id))
    const target = (event.currentTarget.closest('.piano-velocity-bars') ?? event.currentTarget) as HTMLElement
    target.dataset.dawGesture = 'velocity'
    gestureRef.current = {
      kind: 'velocity', anchorId: note.id, originals: clip.notes.filter(item => selection.has(item.id)),
      pending: pending === 'collapse' ? 'collapse' : null, moved: null, prevSelection: selection,
      pointerId: event.pointerId, target, originX: event.clientX, originY: event.clientY, activated: false,
    }
    try { target.setPointerCapture(event.pointerId) } catch { cancelGesture() }
  }

  function moveVelocity(gesture: VelocityGesture, event: PointerEvent<HTMLElement>) {
    const dy = event.clientY - gesture.originY
    if (!gesture.activated && !crossedDragThreshold(0, dy, 2)) return
    gesture.activated = true
    gesture.pending = null
    const change = -dy / LANE_RANGE
    const anchor = gesture.originals.find(note => note.id === gesture.anchorId)
    // Shift sets every selected note to the anchor's value (Logic's ⌥⇧-drag).
    const moved = gesture.originals.map(note => ({ ...note, velocity: clamp((event.shiftKey && anchor ? anchor.velocity : note.velocity) + change, MIN_VELOCITY, 1) }))
    gesture.moved = moved
    const byId = new Map(moved.map(note => [note.id, note]))
    setDraft(clip.notes.map(note => byId.get(note.id) ?? note))
  }

  function endVelocity(gesture: VelocityGesture, commitChange: boolean) {
    if (!gesture.activated) {
      if (commitChange && gesture.pending === 'collapse') setSelectedIds(new Set([gesture.anchorId]))
      return
    }
    const moved = gesture.moved
    if (!commitChange || !moved || !moved.some((note, index) => !sameNote(note, gesture.originals[index]))) return
    const byId = new Map(moved.map(note => [note.id, note]))
    commit(clip.notes.map(note => byId.get(note.id) ?? note))
    const anchor = byId.get(gesture.anchorId)
    if (anchor) lastRef.current.velocity = anchor.velocity
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (gesture.kind === 'note') moveNoteGesture(gesture, event)
    else if (gesture.kind === 'marquee') moveMarquee(gesture, event)
    else moveVelocity(gesture, event)
  }

  function handlePointerEnd(event: PointerEvent<HTMLElement>, commitChange: boolean) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.stopPropagation()
    if (commitChange) handlePointerMove(event)
    gestureRef.current = null
    delete gesture.target.dataset.dawGesture
    if (gesture.target.hasPointerCapture(event.pointerId)) gesture.target.releasePointerCapture(event.pointerId)
    setDraft(null)
    setAlignmentBeat(null)
    if (gesture.kind === 'note') endNoteGesture(gesture, commitChange)
    else if (gesture.kind === 'marquee') endMarquee(gesture, commitChange)
    else endVelocity(gesture, commitChange)
  }

  const pointerHandlers = {
    onPointerMove: handlePointerMove,
    onPointerUp: (event: PointerEvent<HTMLElement>) => handlePointerEnd(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => handlePointerEnd(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => handlePointerEnd(event, false),
  }

  function deleteSelected() {
    if (!selectedIds.size) return
    cancelGesture()
    cancelSlider()
    // Keep keyboard focus in the editor after removing its focused note.
    // A held Delete must never fall back to a region or track command.
    focusRoot()
    commit(clip.notes.filter(note => !selectedIds.has(note.id)))
    setSelectedIds(new Set())
  }

  function copySelected() {
    const selected = selectedFromClip()
    if (!selected.length) return false
    const minStart = Math.min(...selected.map(note => note.start))
    noteClipboard = selected.sort(byTime).map(note => ({ ...note, start: note.start - minStart }))
    return true
  }

  function insertNotes(source: MidiNote[], offset: number) {
    const inserted = source
      .map(note => ({ ...note, id: newId(), start: note.start + offset }))
      .filter(note => note.start >= 0 && note.start < clip.lengthBeats)
      .map(note => ({ ...note, duration: Math.min(note.duration, clip.lengthBeats - note.start) }))
    if (!inserted.length) return
    commit([...clip.notes, ...inserted])
    setSelectedIds(new Set(inserted.map(note => note.id)))
    anchorRef.current = inserted[0].id
  }

  function paste(at?: number) {
    if (!noteClipboard.length) return
    const selected = selectedFromClip()
    const position = at ?? (showPlayhead && localPlayhead! < clip.lengthBeats ? localPlayhead! : selected.length ? Math.min(...selected.map(note => note.start)) : 0)
    insertNotes(noteClipboard, clamp(position, 0, clip.lengthBeats))
  }

  function duplicateSelected() {
    const selected = selectedFromClip()
    if (!selected.length) return
    const minStart = Math.min(...selected.map(note => note.start))
    const maxEnd = Math.max(...selected.map(note => note.start + note.duration))
    const target = snap > 0 ? Math.ceil(maxEnd / snap - 1e-6) * snap : maxEnd
    insertNotes(selected, target - minStart)
  }

  function quantize(lengths: boolean) {
    const grid = snap || 0.25
    const targets = selectedIds.size ? selectedIds : new Set(clip.notes.map(note => note.id))
    let changed = false
    const next = clip.notes.map(note => {
      if (!targets.has(note.id)) return note
      const start = clamp(Math.round(note.start / grid) * grid, 0, Math.max(0, clip.lengthBeats - grid))
      const duration = Math.min(lengths ? Math.max(grid, Math.round(note.duration / grid) * grid) : note.duration, clip.lengthBeats - start)
      if (start === note.start && duration === note.duration) return note
      changed = true
      return { ...note, start, duration }
    })
    if (changed) commit(next)
  }

  function transposeSelected(direction: 1 | -1, octave: boolean) {
    const selected = selectedFromClip()
    if (!selected.length) return
    let pitchFor: (note: MidiNote) => number
    if (drumMode) {
      const rows = selected.map(note => pitchRows.get(note.pitch) ?? 0)
      if (Math.min(...rows) - direction < 0 || Math.max(...rows) - direction > pitches.length - 1) return
      pitchFor = note => pitches[(pitchRows.get(note.pitch) ?? 0) - direction]
    } else {
      const delta = direction * (octave ? 12 : 1)
      if (Math.min(...selected.map(note => note.pitch)) + delta < 0 || Math.max(...selected.map(note => note.pitch)) + delta > 127) return
      pitchFor = note => note.pitch + delta
    }
    commit(clip.notes.map(note => selectedIds.has(note.id) ? { ...note, pitch: pitchFor(note) } : note))
    const anchor = anchorNote()
    if (anchor) onPreview(pitchFor(anchor))
  }

  function nudgeSelected(direction: 1 | -1, length: boolean) {
    const selected = selectedFromClip()
    if (!selected.length) return
    const moved = editNoteTiming(selected, grid.stepBeats * direction, clip.lengthBeats, length ? 'resize' : 'move', Math.max(MIN_LENGTH, grid.stepBeats))
    if (moved === selected) return
    const byId = new Map(moved.map(note => [note.id, note]))
    commit(clip.notes.map(note => byId.get(note.id) ?? note))
    if (length) {
      const anchor = byId.get(anchorNote()?.id ?? '')
      if (anchor) rememberLength(anchor.duration)
    }
  }

  function setSelectionVelocity(value: number) {
    const next = clamp(value, MIN_VELOCITY, 1)
    lastRef.current.velocity = next
    if (!selectedIds.size || selectedFromClip().every(note => Math.abs(note.velocity - next) < 0.0001)) return
    commit(clip.notes.map(note => selectedIds.has(note.id) ? { ...note, velocity: next } : note))
  }

  function selectAll() {
    setSelectedIds(new Set(clip.notes.map(note => note.id)))
  }

  function selectAdjacent(direction: 1 | -1, additive: boolean) {
    const sorted = [...clip.notes].sort(byTime)
    if (!sorted.length) return
    const anchor = anchorNote(direction)
    const next = anchor ? sorted[clamp(sorted.findIndex(note => note.id === anchor.id) + direction, 0, sorted.length - 1)] : direction > 0 ? sorted[0] : sorted[sorted.length - 1]
    selectNote(next, additive)
  }

  function selectVertical(up: boolean, additive: boolean) {
    const anchor = anchorNote()
    if (!anchor) { const first = [...clip.notes].sort(byTime)[0]; if (first) selectNote(first, additive); return }
    const row = pitchRows.get(anchor.pitch) ?? 0
    const anchorEnd = anchor.start + anchor.duration
    const score = (note: MidiNote) => {
      const overlaps = note.start < anchorEnd && note.start + note.duration > anchor.start
      return [overlaps ? 0 : Math.abs(note.start - anchor.start), Math.abs((pitchRows.get(note.pitch) ?? 0) - row)]
    }
    const best = clip.notes
      .filter(note => { const r = pitchRows.get(note.pitch) ?? 0; return up ? r < row : r > row })
      .map(note => ({ note, score: score(note) }))
      .sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1])[0]
    if (best) selectNote(best.note, additive)
  }

  /** App shortcuts can target the last editor even while an ordinary toolbar owns DOM focus. */
  function executeCommand(command: ProjectShortcut): boolean {
    const actions: Partial<Record<ProjectShortcut, () => void>> = {
      copy: () => { copySelected() }, cut: () => { if (copySelected()) deleteSelected() }, paste: () => paste(),
      selectAll, deleteNotes: deleteSelected, quantize: () => quantize(false),
      nudgeLeft: () => nudgeSelected(-1, false), nudgeRight: () => nudgeSelected(1, false),
      trimEndLeft: () => nudgeSelected(-1, true), trimEndRight: () => nudgeSelected(1, true),
      transposeUp: () => transposeSelected(1, false), transposeDown: () => transposeSelected(-1, false),
      transposeOctaveUp: () => transposeSelected(1, !drumMode), transposeOctaveDown: () => transposeSelected(-1, !drumMode),
      snapToggle: () => setSnap(snap > 0 ? 0 : previousSnap.current),
    }
    const action = actions[command]
    if (!action) return false
    if (!gestureRef.current && sliderDraftRef.current === null) action()
    return true
  }
  useLayoutEffect(() => {
    if (!commandRef) return
    commandRef.current = executeCommand
    return () => { commandRef.current = null }
  })

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || isShortcutSuppressed(event.nativeEvent, true)) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input,textarea,select,[contenteditable],[data-selectable-text],[role="textbox"],[role="slider"]')
      || (target?.closest('button') && !target.closest('.piano-note'))) return
    const native = event.nativeEvent
    const handled = () => { event.preventDefault(); event.stopPropagation() }
    const mod = event.ctrlKey !== event.metaKey && !event.altKey
    const letter = (code: string, key: string) => event.code ? event.code === code : event.key.toLowerCase() === key
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    if (event.key === 'Escape' && isUnmodified(native)) {
      handled()
      if (event.repeat) return
      if (gestureRef.current) cancelGesture()
      else setSelectedIds(new Set())
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && isUnmodified(native)) {
      handled()
      if (!event.repeat && !gestureRef.current) deleteSelected()
      return
    }
    if (gestureRef.current) {
      if (arrow) handled()
      return
    }
    if (mod && !event.shiftKey) {
      const action = letter('KeyA', 'a') ? () => executeCommand('selectAll') : letter('KeyC', 'c') ? () => executeCommand('copy') : letter('KeyX', 'x') ? () => executeCommand('cut')
        : letter('KeyV', 'v') ? () => executeCommand('paste') : letter('KeyD', 'd') ? duplicateSelected : letter('KeyG', 'g') ? () => executeCommand('snapToggle') : null
      if (!action) return
      handled()
      if (!event.repeat) action()
      return
    }
    if (letter('KeyQ', 'q') && isUnmodified(native, true)) {
      handled()
      if (!event.repeat) quantize(event.shiftKey)
      return
    }
    if (!arrow) return
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      handled()
      if (horizontal) nudgeSelected(direction, event.shiftKey)
      else transposeSelected(direction, event.shiftKey && !drumMode)
    } else if (isUnmodified(native, true)) {
      handled()
      if (event.shiftKey) {
        if (horizontal) selectAdjacent(direction, true)
        else selectVertical(direction > 0, true)
      } else if (horizontal) nudgeSelected(direction, false)
      else transposeSelected(direction, false)
    }
  }

  function commitSlider(value: number) {
    if (sliderDraftRef.current === null) return
    cancelSlider()
    setSelectionVelocity(value / 127)
  }

  function openMenu(event: MouseEvent<HTMLElement>, kind: MenuState['kind'], beat?: number) {
    event.preventDefault()
    event.stopPropagation()
    if (gestureRef.current) return
    let { clientX: x, clientY: y } = event
    if (x === 0 && y === 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      x = rect.left + Math.min(24, rect.width / 2)
      y = rect.bottom
    }
    setMenu({ x, y, kind, beat })
  }

  const hasSelection = selectedIds.size > 0 && selectedNotes.length > 0
  const menuItems: ContextMenuItem[] = [
    { label: '삭제', icon: 'trash', shortcut: 'Del', danger: true, disabled: !hasSelection, onSelect: deleteSelected },
    { label: '복제', icon: 'copy', shortcut: `${modLabel}D`, disabled: !hasSelection, onSelect: duplicateSelected },
    { type: 'separator' },
    { label: '잘라내기', icon: 'scissors', shortcut: `${modLabel}X`, disabled: !hasSelection, onSelect: () => { if (copySelected()) deleteSelected() } },
    { label: '복사', icon: 'copy', shortcut: `${modLabel}C`, disabled: !hasSelection, onSelect: copySelected },
    { label: '붙여넣기', icon: 'paste', shortcut: `${modLabel}V`, disabled: !noteClipboard.length, onSelect: () => paste(menu?.kind === 'grid' ? menu.beat : undefined) },
    { type: 'separator' },
    { label: hasSelection ? '퀀타이즈' : '모두 퀀타이즈', icon: 'grid', shortcut: 'Q', disabled: !clip.notes.length, onSelect: () => quantize(false) },
    { label: '벨로시티', icon: 'volume', disabled: !hasSelection, items: [100, 75, 50, 25].map(percent => ({ label: `${percent}%`, checked: hasSelection && selectedNotes.every(note => Math.abs(note.velocity - percent / 100) < 0.005), onSelect: () => setSelectionVelocity(percent / 100) })) },
    ...(drumMode ? [] : [
      { label: '옥타브 ↑', icon: 'arrowsV', shortcut: `${altLabel}⇧↑`, disabled: !hasSelection, onSelect: () => transposeSelected(1, true) },
      { label: '옥타브 ↓', icon: 'arrowsV', shortcut: `${altLabel}⇧↓`, disabled: !hasSelection, onSelect: () => transposeSelected(-1, true) },
    ]),
    { type: 'separator' },
    { label: '모두 선택', icon: 'select-all', shortcut: `${modLabel}A`, disabled: !clip.notes.length, onSelect: selectAll },
  ]

  const gridStyle = musicalGridStyle(grid)
  const rulerMarks = musicalRulerMarks(grid, Math.max(0, viewport.left / beatWidth - 4), Math.min(clipBeats, (viewport.left + Math.max(0, viewport.width - KEY_WIDTH)) / beatWidth + 4))
  const style = {
    '--piano-color': color,
    '--piano-note-text': contrastTextColor(color),
    '--piano-note-selected-text': contrastTextColor(color, .2),
    '--piano-row': `${ROW}px`,
    '--piano-step': `${beatWidth * grid.stepBeats}px`,
    '--piano-beat': `${beatWidth}px`,
    '--piano-bar': `${beatWidth * 4}px`,
  } as CSSProperties
  const gridHeight = pitches.length * ROW

  return (
    <section className={`piano-roll${drumMode ? ' piano-roll--drums' : ''}${ROW < COMPACT_ROW ? ' piano-roll--compact' : ''}`} style={style} ref={rootRef} tabIndex={0} data-keyboard-scope="piano" onKeyDown={handleKeyDown}
      onContextMenu={event => { if (event.target === event.currentTarget) openMenu(event, 'grid', 0) }} aria-label="피아노롤 음표 편집기">
      <header className="piano-header">
        <div className="piano-heading">
          <span className="piano-keyboard-icon" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>{drumMode ? '드럼 에디터' : '피아노롤'}</strong>
          <span className="piano-header-divider" />
          <span className="piano-clip-name" title={clip.name}>{clip.name}</span>
        </div>
        <div className="piano-header-right">
          {primaryNote ? <span className="piano-selection-label">{labelForPitch(primaryNote.pitch)} <span>· {Number(primaryNote.duration.toFixed(3))}박</span></span>
            : selectedNotes.length > 1 && <span className="piano-selection-label">{selectedNotes.length}<span>개 선택</span></span>}
          <ZoomControls area={drumMode ? '드럼 에디터' : '피아노롤'} onZoom={zoomCommand} />
          <button type="button" className={`piano-lane-toggle${showVelocity ? ' active' : ''}`} aria-pressed={showVelocity} onClick={() => setShowVelocity(value => !value)} title="벨로시티 레인 보이기/숨기기">VEL</button>
          <label className="piano-snap" title={`마우스는 기본 자유 이동 · 필요할 때 격자 선택 · ${modLabel}G: 스냅 켬/끔 · 드래그 중 ${mac ? '⌃' : 'Ctrl'}: 세밀하게 · ${mac ? '⌃⇧' : 'Ctrl+Shift'}: 격자 무시 · Shift: 축 고정 · 방향키: 표시 격자 한 칸`}>
            <span aria-hidden="true">▦</span>
            <select value={String(snap)} onChange={event => setSnap(Number(event.currentTarget.value))} aria-label="마우스 스냅 격자">
              {SNAP_OPTIONS.map(([label, value]) => <option key={label} value={String(value)}>{label}</option>)}
            </select>
          </label>
        </div>
      </header>

      <div className="piano-scroll" ref={scrollRef} onScroll={event => { const left = event.currentTarget.scrollLeft; setViewport(previous => previous.left === left ? previous : { ...previous, left }) }}>
        <div className="piano-content" style={{ width: gridWidth + KEY_WIDTH, height: gridHeight + RULER_HEIGHT + (showVelocity ? LANE_HEIGHT : 0) }}>
          <div className="piano-ruler" style={{ height: RULER_HEIGHT }}>
            <div className="piano-ruler-corner" style={{ width: KEY_WIDTH }}>NOTE</div>
            <div className="piano-ruler-beats" style={{ width: gridWidth }}>
              {rulerMarks.map(mark => <span key={mark.beat} className={`piano-ruler-mark piano-ruler-mark--${mark.kind}`} style={{ left: mark.beat * beatWidth }} aria-hidden="true">{mark.label && <span>{mark.label}</span>}</span>)}
              {showPlayhead && <span className="piano-ruler-playhead" style={{ left: localPlayhead! * beatWidth }} aria-hidden="true" />}
            </div>
          </div>

          <div className="piano-body">
            <div className="piano-keys" style={{ width: KEY_WIDTH }}>
              {pitches.map(pitch => <button
                type="button" key={pitch}
                className={`piano-key${!drumMode && isBlackKey(pitch) ? ' piano-key--black' : ''}${pitch % 12 === 0 ? ' piano-key--octave' : ''}${hoveredPitch === pitch || draggingPitches?.has(pitch) ? ' piano-key--active' : ''}`}
                style={{ height: ROW }}
                onClick={event => {
                  event.stopPropagation()
                  onPreview(pitch)
                  const ids = clip.notes.filter(note => note.pitch === pitch).map(note => note.id)
                  setSelectedIds(event.shiftKey ? new Set([...selectedIds, ...ids]) : new Set(ids))
                }}
                onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
                title={`${labelForPitch(pitch)} 미리 듣기 · 이 음높이의 음표 선택`}
                aria-label={`${labelForPitch(pitch)} 미리 듣기 및 선택`}
              ><span>{drumMode ? labelForPitch(pitch) : pitch % 12 === 0 || isBlackKey(pitch) ? pitchName(pitch) : pitchClassName(pitch)}</span>{drumMode && <small>{pitch}</small>}</button>)}
            </div>

            <div className="piano-grid" ref={canvasRef} style={{ width: gridWidth, height: gridHeight, ...gridStyle }}
              onPointerDown={beginMarquee}
              {...pointerHandlers}
              onContextMenu={event => {
                if (event.target !== event.currentTarget) return
                const beat = canvasPoint(event).x / beatWidth
                openMenu(event, 'grid', snap > 0 ? Math.floor(beat / snap) * snap : beat)
              }}
              aria-label="빈칸을 클릭해 음표 추가, 드래그해 여러 음표 선택. 기본 마우스 이동과 길이 편집은 자유롭게, 선택한 음표는 좌우 방향키로 표시 격자 한 칸, 위아래 방향키로 음높이 한 칸씩 이동합니다. Shift 방향키는 선택을 확장합니다."
            >
              <div className="piano-grid-rows" aria-hidden="true">
                {pitches.map(pitch => <div key={pitch} className={`piano-grid-row${!drumMode && isBlackKey(pitch) ? ' piano-grid-row--black' : ''}${pitch % 12 === 0 ? ' piano-grid-row--octave' : ''}`} style={{ height: ROW }} />)}
              </div>
              {notes.map(note => {
                const row = pitchRows.get(note.pitch)
                if (row === undefined) return null
                const original = clipNotesById.get(note.id) ?? note
                const selected = selectedIds.has(note.id)
                const geometry = musicalSpan(note.start, Math.min(note.duration, clip.lengthBeats - note.start), beatWidth)
                const width = geometry.width
                const noteVelocity = selected && sliderDraft !== null ? sliderDraft : note.velocity
                return <button
                  type="button" key={note.id} data-note-id={note.id}
                  className={`piano-note${selected ? ' piano-note--selected' : ''}${draft && selected ? ' piano-note--dragging' : ''}`}
                  style={{ ...geometry, top: row * ROW + 2, height: ROW - 4, borderWidth: width < 2 ? 0 : undefined, '--note-velocity': clamp(noteVelocity, 0.1, 1) } as CSSProperties}
                  onFocus={() => { if (!pointerFocusRef.current && !selectedIds.has(note.id)) { setSelectedIds(new Set([note.id])); anchorRef.current = note.id } }}
                  onPointerDown={event => beginNoteGesture(event, original, 'move')}
                  onMouseEnter={() => setHoveredPitch(note.pitch)}
                  onMouseLeave={() => setHoveredPitch(null)}
                  onClick={event => { event.stopPropagation(); if (event.detail === 0) { setSelectedIds(new Set([note.id])); anchorRef.current = note.id; onPreview(note.pitch) } }}
                  onKeyUp={event => { if (event.key === ' ') event.preventDefault() }}
                  onContextMenu={event => {
                    if (!selectedIds.has(note.id)) { setSelectedIds(new Set([note.id])); anchorRef.current = note.id }
                    openMenu(event, 'note')
                  }}
                  aria-label={`${labelForPitch(note.pitch)}, ${Number((note.start + 1).toFixed(3))}박 위치, 길이 ${Number(note.duration.toFixed(3))}박, 세기 ${Math.round(noteVelocity * 127)}`}
                  aria-pressed={selected}
                  title={`${labelForPitch(note.pitch)} · ${snap > 0 ? '격자에 맞춰' : '자유롭게'} 드래그 이동 · ←→ 표시 격자 한 칸 · ↑↓ ${drumMode ? '한 행' : '반음'} · ⇧방향키 선택 확장 · ${altLabel.replace('+', '')} 드래그 복사 · 양 끝으로 길이 조절`}
                >
                  {width > 34 && ROW >= COMPACT_ROW && <span className="piano-note-label">{drumMode ? DRUM_NAMES[note.pitch]?.replace('CLOSED HAT', 'CH').replace('OPEN HAT', 'OH') ?? pitchName(note.pitch) : pitchName(note.pitch)}</span>}
                  <span className="piano-note-velocity" aria-hidden="true" />
                  {width >= 18 && <span className="piano-note-resize piano-note-resize--left" onPointerDown={event => beginNoteGesture(event, original, 'resize-left')} title="드래그하여 음표 시작 위치 조절" aria-hidden="true" />}
                  <span className="piano-note-resize" style={{ width: Math.min(7, width / 3) }} onPointerDown={event => beginNoteGesture(event, original, 'resize')} title="드래그하여 음표 길이 조절" aria-hidden="true" />
                </button>
              })}
              {marquee && <div className="piano-marquee" style={marquee} aria-hidden="true" />}
              {alignmentBeat !== null && <div className="piano-alignment-guide" style={{ left: alignmentBeat * beatWidth }} aria-hidden="true" />}
              {showPlayhead && <div className="piano-playhead" style={{ left: localPlayhead! * beatWidth }} aria-hidden="true" />}
            </div>
          </div>

          {showVelocity && <div className="piano-velocity-lane" style={{ height: LANE_HEIGHT }}>
            <div className="piano-velocity-corner" style={{ width: KEY_WIDTH }}>VELOCITY</div>
            <div className="piano-velocity-bars" style={{ width: gridWidth, ...gridStyle }} {...pointerHandlers} aria-hidden="true">
              {[...notes].sort((a, b) => Number(selectedIds.has(a.id)) - Number(selectedIds.has(b.id))).map(note => {
                const selected = selectedIds.has(note.id)
                const noteVelocity = selected && sliderDraft !== null ? sliderDraft : note.velocity
                const original = clipNotesById.get(note.id) ?? note
                return <span key={note.id}
                  className={`piano-velocity-bar${selected ? ' piano-velocity-bar--selected' : ''}`}
                  style={{ left: note.start * beatWidth, '--bar-height': `${Math.max(2, noteVelocity * LANE_RANGE)}px`, '--note-velocity': clamp(noteVelocity, 0.15, 1) } as CSSProperties}
                  onPointerDown={event => beginVelocity(event, original)}
                  title={`${labelForPitch(note.pitch)} · 세기 ${Math.round(noteVelocity * 127)} · 위아래로 드래그 (Shift: 선택한 음표를 같은 값으로)`}
                />
              })}
              {showPlayhead && <div className="piano-playhead" style={{ left: localPlayhead! * beatWidth }} />}
            </div>
          </div>}
        </div>
      </div>

      <footer className="piano-footer">
        <label className={`piano-velocity-control${hasSelection ? '' : ' piano-velocity-control--disabled'}`}>
          <span className="piano-velocity-label">VELOCITY</span>
          <input type="range" min={1} max={127} step={1} value={velocityValue} disabled={!hasSelection}
            aria-label="선택한 음표의 세기" aria-valuetext={`${velocityValue} / 127`}
            onChange={event => { sliderDraftRef.current = Number(event.currentTarget.value) / 127; setSliderDraft(sliderDraftRef.current) }}
            onPointerUp={event => commitSlider(Number(event.currentTarget.value))}
            onPointerCancel={() => cancelSlider()}
            onKeyUp={event => { event.stopPropagation(); if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSlider(Number(event.currentTarget.value)) }}
            onBlur={event => { if (document.hasFocus()) commitSlider(Number(event.currentTarget.value)); else cancelSlider() }}
            title={hasSelection ? '선택한 음표의 연주 세기 조절' : '음표를 선택해 세기를 조절하세요'}
          />
          <output>{hasSelection ? velocityValue : '—'}</output>
        </label>
        <span className="piano-help">마우스 {snap > 0 ? '격자 맞춤' : '자유 이동'} <span>·</span> ←→ 한 칸 <span>·</span> ↑↓ {drumMode ? '한 행' : '반음'} <span>·</span> ⇧방향키 선택 확장</span>
        <span className="piano-note-count">{clip.notes.length}<span> NOTES</span></span>
      </footer>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} label="음표 메뉴" />}
    </section>
  )
}
