import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject } from 'react'
import type { ControllerKey, InstrumentId, MidiClip, MidiNote } from '../core/types'
import { crossedDragThreshold, dragModifiers, isShortcutSuppressed, isUnmodified, shortcutPlatform, snapDragDelta, type ProjectShortcut } from '../core/input'
import { GM_KIT_NAMES, instrumentDef } from '../core/instruments'
import { pitchClassName, pitchName } from '../core/pitch'
import { contrastTextColor } from '../core/colors'
import { applyMidiNoteEdits, midiEditorClip } from '../core/midiRegions'
import { musicalGrid, musicalGridStyle, musicalRulerMarks, musicalSpan } from '../core/musicalGrid'
import { snapToEdges } from '../core/edgeSnap'
import { editNoteTiming, noteTimingBounds, pianoNoteStart, MIN_PIANO_NOTE_LENGTH as MIN_LENGTH } from '../core/pianoEditing'
import { ZOOM_KEY_FACTOR, ZOOM_KEY_FACTOR_V, ZOOM_LIMITS, clampZoom, fitScale, zoomBy, type ZoomCommand, type ZoomHandle, type ZoomState } from '../core/zoom'
import { bakeSustain, sustainPressCount } from '../core/sustain'
import SustainLane from './SustainLane'
import ControllerLane, { CONTROLLER_TOOLS, type ControllerTool } from './ControllerLane'
import { ccKey, controllerKeys, controllerName, controllerOrder, controllerSpec } from '../core/controllers'
import { LANE_COLLAPSED_HEIGHT, LANE_SPLITTER_HEIGHT, layoutLanePane, loadLanePane, saveLanePane, type LanePanePrefs } from './pianoLaneLayout'
import ContextMenu from './ContextMenu'
import { QuantizePopover, loadPianoQuantize, savePianoQuantize, type PianoQuantizeSettings } from './QuantizePopover'
import { quantizeNotes } from '../core/quantize'
import type { ContextMenuItem } from './ContextMenu'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
import { ZoomControls } from './ZoomControls'
import './PianoRoll.css'

type PianoZoom = ZoomState['piano']

/** A transport clock store (useSyncExternalStore contract): `getBeat` returns the absolute project beat. */
export interface PlayheadSource {
  subscribe: (callback: () => void) => () => void
  getBeat: () => number
  /** While playing, a ruler drag only moves the drawn playhead and seeks once on release. */
  isPlaying?: () => boolean
}
const noSubscription = () => () => {}

/** The clip-local playhead beat, or null when outside the clip / no transport. Re-renders only its caller. */
function useLocalPlayhead(source: PlayheadSource | undefined, beat: number | undefined, clipStart: number, clipLength: number): number | null {
  const absolute = useSyncExternalStore(source?.subscribe ?? noSubscription, () => source ? source.getBeat() : beat ?? null)
  if (absolute === null || absolute === undefined) return null
  const local = absolute - clipStart
  return local >= 0 && local <= clipLength ? local : null
}

interface PlayheadProps { source?: PlayheadSource; beat?: number; clipStart: number; clipLength: number }

/** One playhead mark; the only part of the piano roll that follows the transport clock. */
function PlayheadMark({ source, beat, clipStart, clipLength, beatWidth, className, hidden = true }: PlayheadProps & { beatWidth: number; className: string; hidden?: boolean }) {
  const local = useLocalPlayhead(source, beat, clipStart, clipLength)
  if (local === null) return null
  return className === 'piano-ruler-playhead'
    ? <span className={className} style={{ left: local * beatWidth }} aria-hidden="true" />
    : <div className={className} style={{ left: local * beatWidth }} aria-hidden={hidden || undefined} />
}

/** Lanes read the value at the playhead (controller readout), so they take the clock through a render prop. */
function WithPlayhead({ children, ...props }: PlayheadProps & { children: (local: number | null) => ReactNode }) {
  return <>{children(useLocalPlayhead(props.source, props.beat, props.clipStart, props.clipLength))}</>
}

interface PianoRollProps {
  clip: MidiClip
  color: string
  instrument: InstrumentId
  onChange: (clip: MidiClip) => void
  onPreview: (pitch: number) => void
  /** Absolute project beat of the transport. The playhead is hidden when undefined. */
  playheadBeat?: number
  /**
   * The transport clock as a store. Preferred over `playheadBeat` during playback: only the playhead marks subscribe,
   * so a transport tick never re-renders the note grid (docs/ARCHITECTURE_REVIEW.md, bottleneck 5).
   */
  playhead?: PlayheadSource
  /** Meter durations in the project's quarter-note beat coordinates. */
  beatsPerBar?: number
  beatUnit?: number
  /** Optional mouse snap in beats. Omitted/0 means free placement; arrows use the visible grid. */
  snap?: number
  onSnapChange?: (snap: number) => void
  /** Horizontal ppb (null = fit the clip) and row height. Internal state is used when omitted. */
  zoom?: PianoZoom
  onZoomChange?: (zoom: PianoZoom) => void
  zoomRef?: RefObject<ZoomHandle | null>
  commandRef?: RefObject<((command: ProjectShortcut) => boolean) | null>
  /** Moves the transport to an absolute project beat (ruler click/drag, Home/End, arrows without a selection). */
  onSeek?: (beat: number) => void
}

type Press = { pointerId: number; target: HTMLElement; originX: number; originY: number; activated: boolean; prevSelection: Set<string> }
type NoteGesture = Press & {
  kind: 'note'; mode: 'move' | 'resize' | 'resize-left'; anchorId: string; originals: MidiNote[]
  copyIds: string[] | null; axis: 'x' | 'y' | null; pending: 'collapse' | 'toggle' | null; lastPitch: number; moved: MidiNote[] | null
}
type MarqueeGesture = Press & { kind: 'marquee'; base: Set<string>; plainClick: boolean; hits: Set<string> }
type VelocityGesture = Press & { kind: 'velocity'; anchorId: string; originals: MidiNote[]; pending: 'collapse' | null; moved: MidiNote[] | null }
/** Draw mode (or a ⌘/Ctrl press on empty grid): the press adds a note and dragging right sets its length. */
type DrawGesture = Press & { kind: 'draw'; note: MidiNote; step: number }
type Gesture = NoteGesture | MarqueeGesture | VelocityGesture | DrawGesture
type MenuState = { x: number; y: number; kind: 'note' | 'grid'; beat?: number }

const SNAP_OPTIONS: [string, number][] = [['자유 이동', 0], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/64', 0.0625], ['1/4T', 2 / 3], ['1/8T', 1 / 3], ['1/16T', 1 / 6]]
const ROW_HEIGHT = 19
const COMPACT_ROW = 13
const RULER_HEIGHT = 24
const KEY_WIDTH = 70
/** The note grid keeps this many default rows before the lane pane may grow; at least one row always stays. */
const GRID_MIN_ROWS = 3
/** …or this share of the space under the ruler, whichever is more (the default pane height only; a drag may take more). */
const GRID_MIN_SHARE = 0.4
const SPLITTER_STEP = 8
/** A piano-roll lane under the notes: a controller lane or the sustain pedal (docs/MIDI_CONTROLLERS.md). */
type LaneId = ControllerKey | 'sustain'
type PaneLaneId = LaneId | 'velocity'
const laneOrder = (a: LaneId, b: LaneId): number => a === 'sustain' ? (b === 'sustain' ? 0 : 1) : b === 'sustain' ? -1 : controllerOrder(a, b)
const COMMON_LANES: [LaneId, string][] = [['pitchBend', '피치 벤드'], ['cc1', '모듈레이션 (CC1)'], ['cc11', '익스프레션 (CC11)'], ['cc7', '볼륨 (CC7)'], ['cc10', '팬 (CC10)'], ['sustain', '서스테인 (CC64)'], ['aftertouch', '애프터터치'], ['program', '프로그램 체인지']]
const MIN_VELOCITY = 1 / 127
/** Marquee audition: at most this many newly caught pitches sound per pointer move. */
const MARQUEE_PREVIEW_LIMIT = 4
const PREVIEW_PREF_KEY = 'garak.pianoPreview'
const loadPreviewPref = () => { try { return localStorage.getItem(PREVIEW_PREF_KEY) !== '0' } catch { return true } }
const savePreviewPref = (on: boolean) => { try { localStorage.setItem(PREVIEW_PREF_KEY, on ? '1' : '0') } catch { /* per-browser convenience only */ } }

// Shared between clips so notes can be copied from one region to another. `span` is the grid-rounded length a
// paste advances by, so repeated ⌘V lays copies end to end.
let noteClipboard: MidiNote[] = []
let noteClipboardSpan = 0

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12)
const byTime = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch
const sameNote = (a: MidiNote, b: MidiNote) => a.start === b.start && a.pitch === b.pitch && a.duration === b.duration && a.velocity === b.velocity
const newId = () => `note-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

function PianoRoll({ clip: sourceClip, color, instrument, onChange, onPreview, playheadBeat, playhead, beatsPerBar = 4, beatUnit = 1, snap: snapProp, onSnapChange, zoom: zoomProp, onZoomChange, zoomRef, commandRef, onSeek }: PianoRollProps) {
  const clip = useMemo(() => midiEditorClip(sourceClip), [sourceClip])
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const sliderDraftRef = useRef<number | null>(null)
  // drum null = automatic: half a beat or the snap grid, whichever is longer (until the user resizes a drum hit).
  const lastRef = useRef<{ chromatic: number; drum: number | null; velocity: number }>({ chromatic: 1, drum: null, velocity: 0.8 })
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
  const [addedLanes, setAddedLanes] = useState<LaneId[]>([])
  const [hiddenLanes, setHiddenLanes] = useState<ReadonlySet<LaneId>>(() => new Set())
  const [laneTool, setLaneTool] = useState<ControllerTool>('pencil')
  const [laneMenu, setLaneMenu] = useState<{ x: number; y: number; trigger: Element } | null>(null)
  const [lanePrefs, setLanePrefs] = useState<LanePanePrefs>(loadLanePane)
  const splitterDragRef = useRef<{ pointerId: number; originY: number; origin: number } | null>(null)
  const [drawMode, setDrawMode] = useState(false)
  const [previewOn, setPreviewOn] = useState(loadPreviewPref)
  const [fold, setFold] = useState(false)
  /** Clip-local beat of a ruler drag while playing; the transport seeks once on release. */
  const [scrubLocal, setScrubLocal] = useState<number | null>(null)
  const rulerDragRef = useRef<{ pointerId: number; local: number | null } | null>(null)
  const keyDragRef = useRef<{ pointerId: number; pitch: number } | null>(null)
  const [quantizeOpen, setQuantizeOpen] = useState(false)
  const [quantizeSettings, setQuantizeSettings] = useState<PianoQuantizeSettings>(loadPianoQuantize)
  const [snapState, setSnapState] = useState(0)
  const snap = snapProp ?? snapState
  const previousSnap = useRef(.25)
  if (snap > 0) previousSnap.current = snap

  const def = instrumentDef(instrument)
  const drumMode = def.isKit
  const pedalPresses = sustainPressCount(sourceClip)
  // Lanes with data are shown; pitched instruments also show the pedal lane by default (drum kits only with pedal
  // data). The + menu adds lanes, × hides one (its data stays).
  const dataLanes = controllerKeys(sourceClip)
  const lanes = [...new Set<LaneId>([...dataLanes, ...addedLanes, ...(!drumMode || pedalPresses > 0 ? ['sustain' as const] : [])])].filter(lane => !hiddenLanes.has(lane)).sort(laneOrder)
  // The lane pane under the splitter: velocity on top, then the lanes. Its height is the user's (remembered per
  // browser), clamped so the grid keeps a few rows and each expanded lane a usable height; collapsed lanes are strips.
  const collapsedLanes = new Set(lanePrefs.collapsed)
  const paneLanes: PaneLaneId[] = [...(showVelocity ? ['velocity' as const] : []), ...lanes]
  const laneRoom = viewport.height - RULER_HEIGHT - (paneLanes.length ? LANE_SPLITTER_HEIGHT : 0)
  const pane = layoutLanePane(paneLanes.map(id => ({ kind: id === 'velocity' ? 'velocity' : id === 'sustain' ? 'sustain' : 'controller', collapsed: collapsedLanes.has(id) })),
    lanePrefs.height, laneRoom, Math.max(GRID_MIN_ROWS * ROW_HEIGHT, Math.round(laneRoom * GRID_MIN_SHARE)), ROW_HEIGHT)
  const paneHeight = paneLanes.length ? pane.height + LANE_SPLITTER_HEIGHT : 0
  const laneHeight = (lane: PaneLaneId) => pane.heights[paneLanes.indexOf(lane)] ?? 0
  const lanesHeight = lanes.reduce((total, lane) => total + laneHeight(lane), 0)
  const velocityCollapsed = collapsedLanes.has('velocity')
  const velocityRange = Math.max(8, laneHeight('velocity') - 12)
  const updateLanePrefs = (update: (previous: LanePanePrefs) => LanePanePrefs, persist = true) => setLanePrefs(previous => {
    const next = update(previous)
    if (persist) saveLanePane(next)
    return next
  })
  const setLaneCollapsed = (lane: PaneLaneId, collapsed: boolean) => updateLanePrefs(previous => ({ ...previous, collapsed: collapsed ? [...new Set([...previous.collapsed, lane])] : previous.collapsed.filter(item => item !== lane) }))
  const resizePane = (height: number | null, persist = true) => updateLanePrefs(previous => ({ ...previous, height: height === null ? null : Math.round(Math.min(pane.max, Math.max(pane.min, height))) }), persist)
  const laneLabel = (lane: PaneLaneId) => lane === 'velocity' ? 'VELOCITY' : lane === 'sustain' ? 'SUSTAIN' : controllerSpec(lane).short
  const laneTitle = (lane: PaneLaneId) => lane === 'velocity' ? '벨로시티' : lane === 'sustain' ? '서스테인' : controllerSpec(lane).label
  const showLane = (lane: LaneId) => { setHiddenLanes(previous => { const next = new Set(previous); next.delete(lane); return next }); setAddedLanes(previous => previous.includes(lane) ? previous : [...previous, lane]) }
  const hideLane = (lane: LaneId) => { setHiddenLanes(previous => new Set([...previous, lane])); setAddedLanes(previous => previous.filter(item => item !== lane)) }
  const toggleLane = (lane: LaneId) => lanes.includes(lane) ? hideLane(lane) : showLane(lane)
  const ccGroup = (from: number, to: number): ContextMenuItem => ({ label: `CC ${from}–${to}`, items: Array.from({ length: to - from + 1 }, (_, index) => from + index).filter(number => number !== 64).map(number => ({
    label: `CC ${number}${controllerName(number) ? ` · ${controllerName(number)}` : ''}`, checked: lanes.includes(ccKey(number)), onSelect: () => toggleLane(ccKey(number)),
  })) })
  const laneMenuItems: ContextMenuItem[] = [
    { label: '벨로시티', checked: showVelocity, onSelect: () => setShowVelocity(value => !value) },
    ...COMMON_LANES.map(([lane, label]): ContextMenuItem => ({ label, checked: lanes.includes(lane), onSelect: () => toggleLane(lane) })),
    { type: 'separator' },
    { label: 'CC 번호…', items: [ccGroup(0, 31), ccGroup(32, 63), ccGroup(65, 95), ccGroup(96, 127)] },
    { type: 'separator' },
    { label: '모든 레인 펼치기', disabled: !paneLanes.some(lane => collapsedLanes.has(lane)), onSelect: () => updateLanePrefs(previous => ({ ...previous, collapsed: [] })) },
    { label: '모든 레인 접기', disabled: paneLanes.every(lane => collapsedLanes.has(lane)), onSelect: () => updateLanePrefs(previous => ({ ...previous, collapsed: [...new Set([...previous.collapsed, ...paneLanes])] })) },
    { label: '레인 높이 기본값', disabled: lanePrefs.height === null, onSelect: () => resizePane(null) },
  ]
  const DRUM_NAMES = def.padNames ?? GM_KIT_NAMES
  const pitches = useMemo(() => {
    // Fold: only the pitches that hold notes.
    if (fold && clip.notes.length) return [...new Set(clip.notes.map(note => note.pitch))].sort((a, b) => b - a)
    if (drumMode) return [...new Set([...Object.keys(DRUM_NAMES).map(Number), ...clip.notes.map(note => note.pitch)])].sort((a, b) => b - a)
    const low = Math.max(0, Math.min(24, ...clip.notes.map(note => note.pitch)))
    const high = Math.min(127, Math.max(84, ...clip.notes.map(note => note.pitch)))
    return Array.from({ length: high - low + 1 }, (_, index) => high - index)
  }, [drumMode, DRUM_NAMES, clip.notes, fold])
  const pitchRows = useMemo(() => new Map(pitches.map((pitch, index) => [pitch, index])), [pitches])
  const ROW = Math.round(clampZoom(zoom.rowHeight, ZOOM_LIMITS.pianoY))
  const clipBeats = Math.max(0.25, clip.lengthBeats)
  const fitPpb = fitScale(clipBeats, Math.max(120, viewportWidth - KEY_WIDTH - 1), ZOOM_LIMITS.pianoX)
  const beatWidth = zoom.ppb === null ? fitPpb : clampZoom(zoom.ppb, ZOOM_LIMITS.pianoX)
  const grid = musicalGrid(beatWidth, { snap, beatsPerBar, beatUnit })
  const gridWidth = clipBeats * beatWidth
  const notes = draft ?? clip.notes
  const clipNotesById = useMemo(() => new Map(clip.notes.map(note => [note.id, note])), [clip.notes])
  const selectedNotes = notes.filter(note => selectedIds.has(note.id))
  const primaryNote = selectedNotes.length === 1 ? selectedNotes[0] : null
  const draggingPitches = draft ? new Set(selectedNotes.map(note => note.pitch)) : null
  const velocity = sliderDraft ?? selectedNotes[0]?.velocity ?? lastRef.current.velocity
  const velocityValue = Math.round(clamp(velocity, MIN_VELOCITY, 1) * 127)
  const playheadProps: PlayheadProps = { source: playhead, beat: playheadBeat, clipStart: clip.startBeat, clipLength: clip.lengthBeats }
  /** Read at the moment of a command (paste), never subscribed by the grid. */
  const currentPlayhead = (): number | null => {
    const absolute = playhead ? playhead.getBeat() : playheadBeat
    if (absolute === undefined) return null
    const local = absolute - clip.startBeat
    return local >= 0 && local <= clip.lengthBeats ? local : null
  }
  const mac = shortcutPlatform() === 'mac'
  const modLabel = mac ? '⌘' : 'Ctrl+'
  const altLabel = mac ? '⌥' : 'Alt+'
  const selectedPitches = new Set(selectedNotes.map(note => note.pitch))
  /** Mouse/draw placement grid: the chosen snap, or the visible grid when the snap is free. */
  const drawStep = snap > 0 ? snap : grid.stepBeats
  const playing = () => playhead?.isPlaying?.() ?? false

  /** Note auditions that follow editing (click, marquee, keyboard selection) obey the preview toggle. */
  function audition(pitch: number) {
    if (previewOn) onPreview(pitch)
  }

  /** New-note length: the last length the user set, else for drums max(snap, half a beat). */
  function newNoteLength() {
    if (!drumMode) return lastRef.current.chromatic
    return lastRef.current.drum ?? Math.max(snap, beatUnit / 2)
  }

  /** A grid-rounded span so pasted/duplicated copies land end to end on the beat. */
  function roundedSpan(raw: number) {
    const unit = snap > 0 ? snap : beatUnit
    return Math.max(unit, Math.ceil(raw / unit - 1e-6) * unit)
  }

  function seekLocal(local: number) {
    if (!onSeek) return
    const clamped = clamp(local, 0, clip.lengthBeats)
    onSeek(clip.startBeat + clamped)
    revealBeat(clamped)
  }

  /** Scrolls horizontally just enough to keep a clip-local beat in view. */
  function revealBeat(local: number) {
    const scroll = scrollRef.current
    if (!scroll) return
    const x = local * beatWidth
    const visible = scroll.clientWidth - KEY_WIDTH
    if (x < scroll.scrollLeft + 8) scroll.scrollLeft = Math.max(0, x - 24)
    else if (x > scroll.scrollLeft + visible - 8) scroll.scrollLeft = x - visible + 48
  }

  /** Home: the clip start; pressed again at the clip start, the project start. End: the clip end. */
  function goHome() {
    const absolute = playhead ? playhead.getBeat() : playheadBeat ?? 0
    if (!onSeek) return
    if (Math.abs(absolute - clip.startBeat) > 1e-6) seekLocal(0)
    else onSeek(0)
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }

  function goEnd() {
    seekLocal(clip.lengthBeats)
  }

  /** Arrows without a selection move the playhead one visible grid step inside the clip. */
  function stepPlayhead(direction: 1 | -1) {
    const absolute = playhead ? playhead.getBeat() : playheadBeat
    const step = grid.stepBeats
    const local = absolute === undefined ? null : absolute - clip.startBeat
    if (local === null || local < -1e-6 || local > clip.lengthBeats + 1e-6) { seekLocal(direction > 0 ? 0 : clip.lengthBeats); return }
    const index = Math.round(local / step)
    const onGrid = Math.abs(index * step - local) < 1e-4
    seekLocal((onGrid ? index + direction : direction > 0 ? Math.ceil(local / step) : Math.floor(local / step)) * step)
  }

  function scrollRows(direction: 1 | -1) {
    const scroll = scrollRef.current
    if (scroll) scroll.scrollTop = Math.max(0, scroll.scrollTop - direction * ROW * 2)
  }

  /**
   * The arrow keys, shared by the editor's own handler and routed app commands:
   * with a selection ←→ grid step / ↑↓ semitone, Shift: length / octave;
   * without one ←→ playhead / ↑↓ scroll, Shift: zoom (←→ horizontal, ↑↓ vertical).
   */
  function arrowCommand(key: 'left' | 'right' | 'up' | 'down', shift: boolean) {
    const horizontal = key === 'left' || key === 'right'
    const direction = key === 'right' || key === 'up' ? 1 : -1
    if (selectedFromClip().length) {
      if (horizontal) nudgeSelected(direction, shift)
      else transposeSelected(direction, shift && !drumMode)
    } else if (shift) {
      if (horizontal) zoomX(direction > 0 ? ZOOM_KEY_FACTOR : 1 / ZOOM_KEY_FACTOR, playheadViewportX())
      else zoomY(direction > 0 ? ZOOM_KEY_FACTOR_V : 1 / ZOOM_KEY_FACTOR_V)
    } else if (horizontal) stepPlayhead(direction)
    else scrollRows(direction)
  }

  /** Keyboard zoom keeps the playhead in place when it is visible, else the left edge. */
  function playheadViewportX() {
    const local = currentPlayhead()
    const scroll = scrollRef.current
    if (local === null || !scroll) return KEY_WIDTH
    const x = local * beatWidth - scroll.scrollLeft + KEY_WIDTH
    return x >= KEY_WIDTH && x <= scroll.clientWidth ? x : KEY_WIDTH
  }

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
      if (render && (gesture.kind === 'draw' || (gesture.activated && (gesture.kind === 'marquee' || (gesture.kind === 'note' && gesture.copyIds))))) setSelectedIds(gesture.prevSelection)
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

  // After a keyboard transpose/selection the anchor note stays in view (rows are known only after the render).
  const pendingRevealRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const pitch = pendingRevealRef.current
    pendingRevealRef.current = null
    const scroll = scrollRef.current
    const row = pitch === null ? undefined : pitchRows.get(pitch)
    if (!scroll || row === undefined) return
    const bottom = scroll.clientHeight - paneHeight
    if (row * ROW < scroll.scrollTop) scroll.scrollTop = Math.max(0, (row - 1) * ROW)
    else if (RULER_HEIGHT + (row + 1) * ROW > scroll.scrollTop + bottom) scroll.scrollTop = RULER_HEIGHT + (row + 2) * ROW - bottom
  })

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
    const available = (scroll?.clientHeight ?? viewport.height) - RULER_HEIGHT - paneHeight
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
    audition(note.pitch)
    pendingRevealRef.current = note.pitch
    revealBeat(note.start)
    if (rootRef.current?.contains(document.activeElement)) pendingFocusRef.current = note.id
  }

  function anchorNote(direction = 1) {
    const selected = selectedFromClip().sort(byTime)
    return selected.find(note => note.id === anchorRef.current) ?? (direction < 0 ? selected[0] : selected[selected.length - 1]) ?? null
  }

  function rememberLength(length: number) {
    lastRef.current[drumMode ? 'drum' : 'chromatic'] = length
  }

  /** Pointer selection rule shared by notes and velocity bars. */
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
    // Draw mode: clicking a note erases it.
    if (drawMode) { deleteNote(note.id); return }
    const target = (event.currentTarget.closest('button') ?? event.currentTarget) as HTMLElement
    pointerFocusRef.current = true
    target.focus({ preventScroll: true })
    pointerFocusRef.current = false
    cancelSlider()
    const { selection, pending } = pressSelection(note, event.shiftKey)
    if (mode === 'move') audition(note.pitch)
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
      audition(anchorPitch)
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

  /** Empty grid press: draw in draw mode (or with ⌘/Ctrl held), otherwise a marquee / deselect click. */
  function beginMarquee(event: PointerEvent<HTMLDivElement>) {
    if (!primaryPress(event) || event.target !== event.currentTarget) return
    cancelGesture()
    event.preventDefault()
    focusRoot()
    cancelSlider()
    const temporaryDraw = (mac ? event.metaKey : event.ctrlKey) && !event.altKey
    if (drawMode || temporaryDraw) { beginDraw(event); return }
    const point = canvasPoint(event)
    const target = event.currentTarget
    target.dataset.dawGesture = 'marquee'
    const base = event.shiftKey ? selectedIds : new Set<string>()
    gestureRef.current = {
      kind: 'marquee', base, hits: new Set(base), plainClick: !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey, prevSelection: selectedIds,
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
    const selection = new Set([...gesture.base, ...hits.map(note => note.id)])
    // Audition the pitches that just entered the box (each pitch once per move, a few at a time).
    const entered = [...new Set(hits.filter(note => !gesture.hits.has(note.id)).map(note => note.pitch))].slice(0, MARQUEE_PREVIEW_LIMIT)
    gesture.hits = selection
    entered.forEach(audition)
    setSelectedIds(selection)
  }

  /** A plain click on empty grid clears the selection and, while stopped, moves the playhead there. */
  function endMarquee(gesture: MarqueeGesture, commitChange: boolean) {
    setMarquee(null)
    if (gesture.activated) {
      if (!commitChange) setSelectedIds(gesture.prevSelection)
    } else if (commitChange && gesture.plainClick) {
      setSelectedIds(new Set())
      anchorRef.current = null
      if (!playing()) seekLocal(snapDragDelta(gesture.originX / beatWidth, grid.stepBeats))
    }
  }

  /** A new note under a canvas point, placed on the draw grid (free placement only with ⌃⇧/Ctrl+Shift). */
  function noteAt(x: number, y: number, free = false): MidiNote {
    const row = clamp(Math.floor(y / ROW), 0, pitches.length - 1)
    const start = pianoNoteStart(x / beatWidth, clip.lengthBeats, free ? 0 : drawStep)
    return { id: newId(), pitch: pitches[row], start, duration: Math.max(MIN_LENGTH, Math.min(newNoteLength(), clip.lengthBeats - start)), velocity: lastRef.current.velocity }
  }

  function addNote(note: MidiNote) {
    commit([...clip.notes, note])
    setSelectedIds(new Set([note.id]))
    anchorRef.current = note.id
    cancelSlider()
    audition(note.pitch)
    focusRoot()
  }

  function addNoteAt(x: number, y: number) {
    addNote(noteAt(x, y))
  }

  function deleteNote(id: string) {
    cancelGesture()
    commit(clip.notes.filter(note => note.id !== id))
    setSelectedIds(previous => { const next = new Set(previous); next.delete(id); return next })
    focusRoot()
  }

  function beginDraw(event: PointerEvent<HTMLDivElement>) {
    const point = canvasPoint(event)
    const note = noteAt(point.x, point.y, dragModifiers(event).noSnap)
    const target = event.currentTarget
    target.dataset.dawGesture = 'draw'
    gestureRef.current = { kind: 'draw', note, step: drawStep, prevSelection: selectedIds, pointerId: event.pointerId, target, originX: point.x, originY: point.y, activated: false }
    setDraft([...clip.notes, note])
    setSelectedIds(new Set([note.id]))
    audition(note.pitch)
    try { target.setPointerCapture(event.pointerId) } catch { cancelGesture() }
  }

  function moveDraw(gesture: DrawGesture, event: PointerEvent<HTMLElement>) {
    const point = canvasPoint(event)
    if (!gesture.activated && !crossedDragThreshold(point.x - gesture.originX, 0)) return
    gesture.activated = true
    const free = dragModifiers(event).noSnap
    const rawEnd = point.x / beatWidth
    const end = free ? rawEnd : Math.ceil(rawEnd / gesture.step - 1e-6) * gesture.step
    const minimum = free ? MIN_LENGTH : gesture.step
    const duration = clamp(end - gesture.note.start, Math.min(minimum, clip.lengthBeats - gesture.note.start), clip.lengthBeats - gesture.note.start)
    if (duration === gesture.note.duration) return
    gesture.note = { ...gesture.note, duration }
    setDraft([...clip.notes, gesture.note])
  }

  function endDraw(gesture: DrawGesture, commitChange: boolean) {
    if (!commitChange) { setSelectedIds(gesture.prevSelection); return }
    if (gesture.activated) rememberLength(gesture.note.duration)
    commit([...clip.notes, gesture.note])
    setSelectedIds(new Set([gesture.note.id]))
    anchorRef.current = gesture.note.id
    cancelSlider()
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
    const change = -dy / velocityRange
    const anchor = gesture.originals.find(note => note.id === gesture.anchorId)
    // Shift sets every selected note to the anchor's value.
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
    else if (gesture.kind === 'draw') moveDraw(gesture, event)
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
    else if (gesture.kind === 'draw') endDraw(gesture, commitChange)
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
    noteClipboardSpan = roundedSpan(Math.max(...noteClipboard.map(note => note.start + note.duration)))
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
    const local = currentPlayhead()
    const position = clamp(at ?? (local !== null && local < clip.lengthBeats ? local : selected.length ? Math.min(...selected.map(note => note.start)) : 0), 0, clip.lengthBeats)
    insertNotes(noteClipboard, position)
    // Repeated ⌘V lays copies end to end: the playhead moves past what was just pasted (while stopped).
    if (!playing() && at === undefined) seekLocal(Math.min(clip.lengthBeats, position + (noteClipboardSpan || roundedSpan(0))))
  }

  /** ⌘D: a copy right after the selection, spaced by its grid-rounded length so repeats stay on the beat. */
  function duplicateSelected() {
    const selected = selectedFromClip()
    if (!selected.length) return
    const minStart = Math.min(...selected.map(note => note.start))
    const maxEnd = Math.max(...selected.map(note => note.start + note.duration))
    insertNotes(selected, roundedSpan(maxEnd - minStart))
  }

  /** Destructive Q with the popover's settings (strength, swing, start/end); ⇧Q also moves note ends. */
  function quantize(ends: boolean) {
    const settings = quantizeSettings
    const grid = settings.followSnap ? snap || 0.25 : settings.grid
    const targets = selectedIds.size ? selectedIds : new Set(clip.notes.map(note => note.id))
    const next = quantizeNotes(clip.notes, { ...settings, grid, ends: settings.ends || ends }, clip.lengthBeats, targets)
    if (next.some((note, index) => note !== clip.notes[index])) commit(next)
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
    if (anchor) { audition(pitchFor(anchor)); pendingRevealRef.current = pitchFor(anchor) }
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
      nudgeLeft: () => arrowCommand('left', false), nudgeRight: () => arrowCommand('right', false),
      trimEndLeft: () => arrowCommand('left', true), trimEndRight: () => arrowCommand('right', true),
      transposeUp: () => arrowCommand('up', false), transposeDown: () => arrowCommand('down', false),
      transposeOctaveUp: () => arrowCommand('up', true), transposeOctaveDown: () => arrowCommand('down', true),
      selectPrev: () => selectAdjacent(-1, false), selectNext: () => selectAdjacent(1, false),
      selectNoteAbove: () => selectVertical(true, false), selectNoteBelow: () => selectVertical(false, false),
      home: goHome, end: goEnd, drawMode: () => setDrawMode(on => !on),
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
      || (target?.closest('button') && !target.closest('.piano-note,.piano-key'))) return
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
    if (letter('KeyB', 'b') && isUnmodified(native)) {
      handled()
      if (!event.repeat) setDrawMode(on => !on)
      return
    }
    if ((event.key === 'Home' || event.key === 'End') && isUnmodified(native)) {
      handled()
      if (!event.repeat) { if (event.key === 'Home') goHome(); else goEnd() }
      return
    }
    if (!arrow) return
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      // ⌥/Alt: walk the selection note by note; ⇧ adds to it.
      handled()
      if (horizontal) selectAdjacent(direction, event.shiftKey)
      else selectVertical(direction > 0, event.shiftKey)
    } else if (isUnmodified(native, true)) {
      handled()
      arrowCommand(event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : event.key === 'ArrowUp' ? 'up' : 'down', event.shiftKey)
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
      { label: '옥타브 ↑', icon: 'arrowsV', shortcut: mac ? '⇧↑' : 'Shift+↑', disabled: !hasSelection, onSelect: () => transposeSelected(1, true) },
      { label: '옥타브 ↓', icon: 'arrowsV', shortcut: mac ? '⇧↓' : 'Shift+↓', disabled: !hasSelection, onSelect: () => transposeSelected(-1, true) },
    ]),
    ...(menu?.kind === 'grid' && menu.beat !== undefined && onSeek ? [{ label: '여기로 재생 위치 이동', icon: 'locate', onSelect: () => seekLocal(menu.beat ?? 0) } satisfies ContextMenuItem] : []),
    { type: 'separator' },
    { label: '서스테인을 음 길이로 굳히기', icon: 'keys', disabled: !pedalPresses, onSelect: () => onChange(bakeSustain(sourceClip)) },
    { type: 'separator' },
    { label: '모두 선택', icon: 'select-all', shortcut: `${modLabel}A`, disabled: !clip.notes.length, onSelect: selectAll },
    { label: drawMode ? '선택 모드로' : '그리기 모드로', icon: 'rename', shortcut: 'B', onSelect: () => setDrawMode(on => !on) },
  ]

  const gridStyle = musicalGridStyle(grid)
  const rulerMarks = musicalRulerMarks(grid, Math.max(0, viewport.left / beatWidth - beatsPerBar), Math.min(clipBeats, (viewport.left + Math.max(0, viewport.width - KEY_WIDTH)) / beatWidth + beatsPerBar))
  const style = {
    '--piano-color': color,
    '--piano-note-text': contrastTextColor(color),
    '--piano-note-selected-text': contrastTextColor(color, .2),
    '--piano-row': `${ROW}px`,
    '--piano-step': `${beatWidth * grid.stepBeats}px`,
    '--piano-beat': `${beatWidth * beatUnit}px`,
    '--piano-bar': `${beatWidth * beatsPerBar}px`,
  } as CSSProperties
  const gridHeight = pitches.length * ROW

  /** Ruler: click to move the playhead (visible grid; Shift: free), drag to scrub. While playing only the drawn
   *  playhead follows the drag and the transport seeks once on release, so audio never stutters (as in the timeline). */
  function rulerBeat(event: { clientX: number; shiftKey: boolean }, ruler: HTMLElement) {
    const raw = (event.clientX - ruler.getBoundingClientRect().left) / beatWidth
    return clamp(event.shiftKey ? raw : snapDragDelta(raw, grid.stepBeats), 0, clip.lengthBeats)
  }
  function beginRuler(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || !onSeek) return
    event.preventDefault()
    event.stopPropagation()
    focusRoot()
    const ruler = event.currentTarget
    const local = rulerBeat(event, ruler)
    rulerDragRef.current = { pointerId: event.pointerId, local: null }
    ruler.dataset.dawGesture = 'seek'
    if (playing()) { rulerDragRef.current.local = local; setScrubLocal(local) } else seekLocal(local)
    try { ruler.setPointerCapture(event.pointerId) } catch { /* the click still seeks */ }
  }
  function moveRuler(event: PointerEvent<HTMLElement>) {
    const drag = rulerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const local = rulerBeat(event, event.currentTarget)
    if (playing()) { drag.local = local; setScrubLocal(local) } else if (onSeek) onSeek(clip.startBeat + local)
  }
  function endRuler(event: PointerEvent<HTMLElement>, keep: boolean) {
    const drag = rulerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    rulerDragRef.current = null
    delete event.currentTarget.dataset.dawGesture
    setScrubLocal(null)
    if (keep && drag.local !== null) onSeek?.(clip.startBeat + drag.local)
  }

  /** Keyboard column: a press sounds the key at once (and selects that pitch's notes); dragging plays a glissando. */
  function keyPitchAt(clientY: number, keys: HTMLElement) {
    const row = Math.floor((clientY - keys.getBoundingClientRect().top) / ROW)
    return row >= 0 && row < pitches.length ? pitches[row] : null
  }
  function beginKey(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    const keys = event.currentTarget
    const pitch = keyPitchAt(event.clientY, keys)
    if (pitch === null) return
    event.preventDefault()
    focusRoot()
    onPreview(pitch)
    const ids = clip.notes.filter(note => note.pitch === pitch).map(note => note.id)
    if (ids.length || !event.shiftKey) setSelectedIds(event.shiftKey ? new Set([...selectedIds, ...ids]) : new Set(ids))
    keyDragRef.current = { pointerId: event.pointerId, pitch }
    try { keys.setPointerCapture(event.pointerId) } catch { /* a single press still sounds */ }
  }
  function moveKey(event: PointerEvent<HTMLElement>) {
    const drag = keyDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const pitch = keyPitchAt(event.clientY, event.currentTarget)
    if (pitch === null || pitch === drag.pitch) return
    drag.pitch = pitch
    onPreview(pitch)
  }
  function endKey(event: PointerEvent<HTMLElement>) {
    if (keyDragRef.current?.pointerId === event.pointerId) keyDragRef.current = null
  }

  function beginSplitter(event: PointerEvent<HTMLElement>) {
    if (!pane.resizable || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    splitterDragRef.current = { pointerId: event.pointerId, originY: event.clientY, origin: pane.height }
    event.currentTarget.dataset.dawGesture = 'lane-resize'
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* the drag still follows while the pointer stays on the bar */ }
  }
  function moveSplitter(event: PointerEvent<HTMLElement>) {
    const drag = splitterDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    resizePane(drag.origin - (event.clientY - drag.originY), false)
  }
  function endSplitter(event: PointerEvent<HTMLElement>, keep: boolean) {
    const drag = splitterDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    splitterDragRef.current = null
    delete event.currentTarget.dataset.dawGesture
    if (keep) updateLanePrefs(previous => previous)
    else resizePane(drag.origin)
  }
  function splitterKey(event: KeyboardEvent<HTMLElement>) {
    if (!pane.resizable || event.ctrlKey || event.metaKey || event.altKey) return
    const step = event.shiftKey ? SPLITTER_STEP * 4 : SPLITTER_STEP
    const next = event.key === 'ArrowUp' ? pane.height + step : event.key === 'ArrowDown' ? pane.height - step
      : event.key === 'Home' ? pane.min : event.key === 'End' ? pane.max : event.key === 'Enter' ? null : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    resizePane(next)
  }
  function collapseButton(lane: PaneLaneId, collapsed = false) {
    const action = `${laneTitle(lane)} 레인 ${collapsed ? '펼치기' : '접기'}`
    return <button type="button" className="piano-lane-collapse" aria-expanded={!collapsed} onClick={event => { event.stopPropagation(); setLaneCollapsed(lane, !collapsed) }}
      onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }} title={action} aria-label={action}>
      <span className="piano-lane-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>{laneLabel(lane)}
    </button>
  }
  function laneStrip(lane: PaneLaneId, bottom: number) {
    return <div key={lane} className="piano-lane-slot piano-lane-strip" style={{ height: LANE_COLLAPSED_HEIGHT, bottom }}>
      <div className="piano-velocity-corner piano-lane-strip-corner" style={{ width: KEY_WIDTH }}>{collapseButton(lane, true)}</div>
      <div className="piano-lane-strip-track" style={{ width: gridWidth }} onDoubleClick={() => setLaneCollapsed(lane, false)} title={`더블 클릭: ${laneTitle(lane)} 레인 펼치기`} />
    </div>
  }

  return (
    <section className={`piano-roll${drumMode ? ' piano-roll--drums' : ''}${ROW < COMPACT_ROW ? ' piano-roll--compact' : ''}${drawMode ? ' piano-roll--draw' : ''}`} style={style} ref={rootRef} tabIndex={0} data-keyboard-scope="piano" onKeyDown={handleKeyDown}
      onContextMenu={event => { if (event.target === event.currentTarget) openMenu(event, 'grid', 0) }} aria-label="피아노롤 음표 편집기">
      <header className="piano-header">
        <div className="piano-heading">
          <span className="piano-keyboard-icon" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>{drumMode ? '드럼 에디터' : '피아노롤'}</strong>
          <span className="piano-header-divider" />
          <span className="piano-clip-name" title={clip.name}>{clip.name}</span>
        </div>
        <div className="piano-header-right">
          <span className="piano-mode-switch" role="group" aria-label="마우스 도구">
            <button type="button" className={`piano-lane-toggle${drawMode ? '' : ' active'}`} aria-pressed={!drawMode} onClick={() => setDrawMode(false)}
              title="선택 모드 (B로 전환) · 빈칸 클릭: 선택 해제·재생 위치 · 드래그: 여러 음 선택 · 더블 클릭: 음 추가/삭제">선택</button>
            <button type="button" className={`piano-lane-toggle${drawMode ? ' active' : ''}`} aria-pressed={drawMode} onClick={() => setDrawMode(true)}
              title={`그리기 모드 (B) · 클릭: 음 추가, 오른쪽으로 끌어 길이 · 음 클릭: 삭제 · 선택 모드에서 ${mac ? '⌘' : 'Ctrl'}를 누른 채 빈칸을 누르면 한 번만 그리기`}>✎ 그리기</button>
          </span>
          <button type="button" className={`piano-lane-toggle${previewOn ? ' active' : ''}`} aria-pressed={previewOn}
            onClick={() => setPreviewOn(on => { savePreviewPref(!on); return !on })} title="편집할 때 음 미리 듣기 (클릭·드래그 선택·방향키). 왼쪽 건반은 항상 소리가 납니다.">♪ 소리</button>
          <button type="button" className={`piano-lane-toggle${fold ? ' active' : ''}`} aria-pressed={fold} disabled={!clip.notes.length}
            onClick={() => setFold(on => !on)} title="접기: 음표가 있는 음높이만 보기">접기</button>
          {primaryNote ? <span className="piano-selection-label">{labelForPitch(primaryNote.pitch)} <span>· {Number((primaryNote.duration / beatUnit).toFixed(3))}박</span></span>
            : selectedNotes.length > 1 && <span className="piano-selection-label">{selectedNotes.length}<span>개 선택</span></span>}
          <ZoomControls area={drumMode ? '드럼 에디터' : '피아노롤'} onZoom={zoomCommand} />
          <span className="piano-quantize-anchor">
            <button type="button" className={`piano-lane-toggle piano-quantize-toggle${quantizeOpen ? ' active' : ''}`} aria-expanded={quantizeOpen} aria-haspopup="dialog" onClick={() => setQuantizeOpen(open => !open)} title="퀀타이즈 설정 (Q)">Q</button>
            {quantizeOpen && <QuantizePopover settings={quantizeSettings} hasSelection={selectedIds.size > 0} onChange={next => { setQuantizeSettings(next); savePianoQuantize(next) }} onApply={() => quantize(false)} onClose={() => setQuantizeOpen(false)} />}
          </span>
          <button type="button" className={`piano-lane-toggle${showVelocity ? ' active' : ''}`} aria-pressed={showVelocity} onClick={() => setShowVelocity(value => !value)} title="벨로시티 레인 보이기/숨기기">VEL</button>
          <button type="button" className={`piano-lane-toggle${laneMenu ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={!!laneMenu}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); const trigger = event.currentTarget; setLaneMenu(open => open ? null : { x: rect.left, y: rect.bottom + 2, trigger }) }}
            title={`컨트롤러 레인 추가/숨기기: 피치 벤드, 모듈레이션, 익스프레션, 볼륨, 팬, 서스테인, 애프터터치, CC 번호…${pedalPresses ? ` · 페달 ${pedalPresses}번` : ''}`}>+ 레인</button>
          {lanes.some(lane => lane !== 'sustain') && <label className="piano-snap piano-lane-tool" title="컨트롤러 레인 도구">
            <span aria-hidden="true">✎</span>
            <select value={laneTool} onChange={event => setLaneTool(event.currentTarget.value as ControllerTool)} aria-label="컨트롤러 레인 도구">
              {CONTROLLER_TOOLS.map(([id, label, help]) => <option key={id} value={id} title={help}>{label}</option>)}
            </select>
          </label>}
          <label className="piano-snap" title={`마우스는 기본 자유 이동 · 필요할 때 격자 선택 · ${modLabel}G: 스냅 켬/끔 · 드래그 중 ${mac ? '⌃' : 'Ctrl'}: 세밀하게 · ${mac ? '⌃⇧' : 'Ctrl+Shift'}: 격자 무시 · Shift: 축 고정 · 방향키: 표시 격자 한 칸`}>
            <span aria-hidden="true">▦</span>
            <select value={String(snap)} onChange={event => setSnap(Number(event.currentTarget.value))} aria-label="마우스 스냅 격자">
              {SNAP_OPTIONS.map(([label, value]) => <option key={label} value={String(value)}>{label}</option>)}
            </select>
          </label>
        </div>
      </header>

      <div className="piano-scroll" ref={scrollRef} onScroll={event => { const left = event.currentTarget.scrollLeft; setViewport(previous => previous.left === left ? previous : { ...previous, left }) }}>
        <div className="piano-content" style={{ width: gridWidth + KEY_WIDTH, height: gridHeight + RULER_HEIGHT + paneHeight }}>
          <div className="piano-ruler" style={{ height: RULER_HEIGHT }}>
            <div className="piano-ruler-corner" style={{ width: KEY_WIDTH }}>NOTE</div>
            <div className={`piano-ruler-beats${onSeek ? ' piano-ruler-beats--seek' : ''}`} style={{ width: gridWidth }}
              onPointerDown={beginRuler} onPointerMove={moveRuler} onPointerUp={event => endRuler(event, true)} onPointerCancel={event => endRuler(event, false)} onLostPointerCapture={event => endRuler(event, true)}
              title={onSeek ? '클릭: 재생 위치 이동 · 드래그: 스크럽 (Shift: 격자 무시) · Home: 클립 처음 · End: 클립 끝' : undefined}>
              {rulerMarks.map(mark => <span key={mark.beat} className={`piano-ruler-mark piano-ruler-mark--${mark.kind}`} style={{ left: mark.beat * beatWidth }} aria-hidden="true">{mark.label && <span>{mark.label}</span>}</span>)}
              {scrubLocal === null ? <PlayheadMark {...playheadProps} beatWidth={beatWidth} className="piano-ruler-playhead" />
                : <span className="piano-ruler-playhead" style={{ left: scrubLocal * beatWidth }} aria-hidden="true" />}
            </div>
          </div>

          <div className="piano-body">
            <div className="piano-keys" style={{ width: KEY_WIDTH }} onPointerDown={beginKey} onPointerMove={moveKey} onPointerUp={endKey} onPointerCancel={endKey} onLostPointerCapture={endKey}>
              {pitches.map(pitch => <button
                type="button" key={pitch} tabIndex={-1}
                className={`piano-key${!drumMode && isBlackKey(pitch) ? ' piano-key--black' : ''}${pitch % 12 === 0 ? ' piano-key--octave' : ''}${hoveredPitch === pitch || draggingPitches?.has(pitch) ? ' piano-key--active' : ''}${selectedPitches.has(pitch) ? ' piano-key--selected' : ''}`}
                style={{ height: ROW }}
                onClick={event => { event.stopPropagation(); if (event.detail === 0) onPreview(pitch) }}
                title={`${labelForPitch(pitch)} · 누르면 소리 · 위아래로 끌면 연속 재생 · 이 음높이의 음표 선택 (Shift: 추가)`}
                aria-label={`${labelForPitch(pitch)} 미리 듣기 및 선택`}
              ><span>{drumMode ? labelForPitch(pitch) : pitch % 12 === 0 || isBlackKey(pitch) ? pitchName(pitch) : pitchClassName(pitch)}</span>{drumMode && <small>{pitch}</small>}</button>)}
            </div>

            <div className="piano-grid" ref={canvasRef} style={{ width: gridWidth, height: gridHeight, ...gridStyle }}
              onPointerDown={beginMarquee}
              {...pointerHandlers}
              onDoubleClick={event => {
                if (event.target !== event.currentTarget || drawMode) return
                const point = canvasPoint(event)
                addNoteAt(point.x, point.y)
              }}
              onContextMenu={event => {
                if (event.target !== event.currentTarget) return
                const beat = canvasPoint(event).x / beatWidth
                openMenu(event, 'grid', snap > 0 ? Math.floor(beat / snap) * snap : beat)
              }}
              aria-label={drawMode
                ? '그리기 모드: 빈칸을 눌러 음표를 추가하고 오른쪽으로 끌어 길이를 정합니다. 음표를 누르면 삭제합니다. B 키로 선택 모드로 돌아갑니다.'
                : '선택 모드: 빈칸을 더블 클릭해 음표 추가, 드래그해 여러 음표 선택, 클릭하면 선택 해제와 재생 위치 이동. 선택한 음표는 좌우 방향키로 격자 한 칸, 위아래로 반음, Shift와 함께 길이와 옥타브를 바꿉니다. B 키로 그리기 모드.'}
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
                  onClick={event => { event.stopPropagation(); if (event.detail === 0) { setSelectedIds(new Set([note.id])); anchorRef.current = note.id; audition(note.pitch) } }}
                  onDoubleClick={event => { event.stopPropagation(); if (!drawMode) deleteNote(note.id) }}
                  onKeyUp={event => { if (event.key === ' ') event.preventDefault() }}
                  onContextMenu={event => {
                    if (!selectedIds.has(note.id)) { setSelectedIds(new Set([note.id])); anchorRef.current = note.id }
                    openMenu(event, 'note')
                  }}
                  aria-label={`${labelForPitch(note.pitch)}, ${Number((note.start / beatUnit + 1).toFixed(3))}박 위치, 길이 ${Number((note.duration / beatUnit).toFixed(3))}박, 세기 ${Math.round(noteVelocity * 127)}`}
                  aria-pressed={selected}
                  title={drawMode ? `${labelForPitch(note.pitch)} · 클릭해 삭제 (그리기 모드)` : `${labelForPitch(note.pitch)} · ${snap > 0 ? '격자에 맞춰' : '자유롭게'} 드래그 이동 · 더블 클릭 삭제 · ←→ 격자 한 칸 · ↑↓ ${drumMode ? '한 행' : `반음 · ⇧↑↓ 옥타브`} · ⇧←→ 길이 · ${altLabel.replace('+', '')} 드래그 복사 · 양 끝으로 길이 조절`}
                >
                  {width > 34 && ROW >= COMPACT_ROW && <span className="piano-note-label">{drumMode ? DRUM_NAMES[note.pitch]?.replace('CLOSED HAT', 'CH').replace('OPEN HAT', 'OH') ?? pitchName(note.pitch) : pitchName(note.pitch)}</span>}
                  <span className="piano-note-velocity" aria-hidden="true" />
                  {width >= 18 && <span className="piano-note-resize piano-note-resize--left" onPointerDown={event => beginNoteGesture(event, original, 'resize-left')} title="드래그하여 음표 시작 위치 조절" aria-hidden="true" />}
                  <span className="piano-note-resize" style={{ width: Math.min(7, width / 3) }} onPointerDown={event => beginNoteGesture(event, original, 'resize')} title="드래그하여 음표 길이 조절" aria-hidden="true" />
                </button>
              })}
              {marquee && <div className="piano-marquee" style={marquee} aria-hidden="true" />}
              {alignmentBeat !== null && <div className="piano-alignment-guide" style={{ left: alignmentBeat * beatWidth }} aria-hidden="true" />}
              {scrubLocal === null ? <PlayheadMark {...playheadProps} beatWidth={beatWidth} className="piano-playhead" />
                : <div className="piano-playhead" style={{ left: scrubLocal * beatWidth }} aria-hidden="true" />}
            </div>
          </div>

          {paneLanes.length > 0 && <div className={`piano-lane-splitter${pane.resizable ? '' : ' piano-lane-splitter--fixed'}`} style={{ height: LANE_SPLITTER_HEIGHT, bottom: pane.height }}
            role="separator" aria-orientation="horizontal" aria-label="음표 영역과 레인 사이 크기 조절" tabIndex={pane.resizable ? 0 : -1} aria-disabled={pane.resizable ? undefined : true}
            aria-valuemin={pane.min} aria-valuemax={pane.max} aria-valuenow={pane.height} aria-valuetext={`레인 높이 ${pane.height}px`}
            title="드래그해 레인 높이 조절 · 더블 클릭: 기본 높이 · ↑↓ 키 (Shift: 크게) · Home/End: 최소/최대"
            onPointerDown={beginSplitter} onPointerMove={moveSplitter} onPointerUp={event => endSplitter(event, true)} onPointerCancel={event => endSplitter(event, false)} onLostPointerCapture={event => endSplitter(event, true)}
            onDoubleClick={event => { event.stopPropagation(); resizePane(null) }} onKeyDown={splitterKey}>
            <span className="piano-lane-splitter-grip" aria-hidden="true" />
          </div>}
          {showVelocity && velocityCollapsed && laneStrip('velocity', lanesHeight)}
          {showVelocity && !velocityCollapsed && <div className="piano-velocity-lane" style={{ height: laneHeight('velocity'), bottom: lanesHeight }}>
            <div className="piano-velocity-corner" style={{ width: KEY_WIDTH }}>{collapseButton('velocity')}</div>
            <div className="piano-velocity-bars" style={{ width: gridWidth, ...gridStyle }} {...pointerHandlers} aria-hidden="true">
              {[...notes].sort((a, b) => Number(selectedIds.has(a.id)) - Number(selectedIds.has(b.id))).map(note => {
                const selected = selectedIds.has(note.id)
                const noteVelocity = selected && sliderDraft !== null ? sliderDraft : note.velocity
                const original = clipNotesById.get(note.id) ?? note
                return <span key={note.id}
                  className={`piano-velocity-bar${selected ? ' piano-velocity-bar--selected' : ''}`}
                  style={{ left: note.start * beatWidth, '--bar-height': `${Math.max(2, noteVelocity * velocityRange)}px`, '--note-velocity': clamp(noteVelocity, 0.15, 1) } as CSSProperties}
                  onPointerDown={event => beginVelocity(event, original)}
                  title={`${labelForPitch(note.pitch)} · 세기 ${Math.round(noteVelocity * 127)} · 위아래로 드래그 (Shift: 선택한 음표를 같은 값으로)`}
                />
              })}
              <PlayheadMark {...playheadProps} beatWidth={beatWidth} className="piano-playhead" hidden={false} />
            </div>
          </div>}
          {lanes.map((lane, index) => {
            const bottom = lanes.slice(index + 1).reduce((total, below) => total + laneHeight(below), 0)
            if (collapsedLanes.has(lane)) return laneStrip(lane, bottom)
            return <div key={lane} className="piano-lane-slot" style={{ height: laneHeight(lane), bottom }}>
              <WithPlayhead {...playheadProps}>{local => lane === 'sustain'
                ? <SustainLane clip={sourceClip} beatWidth={beatWidth} gridWidth={gridWidth} gridStyle={gridStyle} keyWidth={KEY_WIDTH} height={laneHeight(lane)}
                  snap={snap} beatsPerBar={beatsPerBar} playhead={local} onChange={onChange} label={collapseButton(lane)} />
                : <ControllerLane clip={sourceClip} laneKey={lane} tool={laneTool} beatWidth={beatWidth} gridWidth={gridWidth} gridStyle={gridStyle} keyWidth={KEY_WIDTH} height={laneHeight(lane)}
                  snap={snap} playhead={local} onChange={onChange} onRemove={() => hideLane(lane)} label={collapseButton(lane)} />}</WithPlayhead>
            </div>
          })}
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
        <span className="piano-help">{drawMode ? <>그리기 <span>·</span> 클릭 추가·끌어 길이 <span>·</span> 음 클릭 삭제 <span>·</span> B 선택 모드</>
          : <>더블 클릭 추가·삭제 <span>·</span> ←→ 한 칸 <span>·</span> ↑↓ {drumMode ? '한 행' : <>반음 <span>·</span> ⇧↑↓ 옥타브</>} <span>·</span> ⇧←→ 길이 <span>·</span> 선택 없이 ⇧방향키 줌 <span>·</span> B 그리기</>}</span>
        <span className="piano-note-count">{clip.notes.length}<span> NOTES</span></span>
      </footer>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} label="음표 메뉴" />}
      {laneMenu && <ContextMenu x={laneMenu.x} y={laneMenu.y} items={laneMenuItems} onClose={() => setLaneMenu(null)} label="컨트롤러 레인 메뉴" trigger={laneMenu.trigger} />}
    </section>
  )
}

/** Memoized: a parent render with equal props (e.g. App state unrelated to this clip) skips the whole note grid. */
export default memo(PianoRoll)
