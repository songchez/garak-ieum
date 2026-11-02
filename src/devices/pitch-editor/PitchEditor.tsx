import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { AudioAsset, AudioClip } from '../../core/types'
import { pitchName } from '../../core/pitch'
import { uid } from '../../core/project'
import { Icon } from '../../components/Icon'
import { analyzePitchInWorker, renderPitchInWorker } from './client'
import { PITCH_RENDERER_ID } from './metadata'
import { PITCH_LIMITS, type PitchEditDocument, type PitchNote, type PitchRenderedEdit } from './model'
import { hasUnsupportedFormantCombination, mergeCandidate, mergeSegments, pitchCurvePath, scopeSegments, segmentFormantShift, segmentShift, shiftFormants, shiftSegments, splitSegment, visibleSelectionIds } from './uiEditing'
import { CORRECTION_CONFIDENCE_THRESHOLD, correctSelectedPitch, PITCH_CORRECTION_SCALES, readPitchCorrectionSettings, rememberPitchCorrectionSettings, type PitchCorrectionOptions, type PitchCorrectionScale } from './correction'
import { enterPitchDraftProject, matchesPitchDraft, pitchDraftConflictMessage, pitchDraftProjectId, pitchDrafts as drafts, scopePitchSnapshot, type PitchDraftSnapshot as Snapshot } from './draftCache'
import './PitchEditor.css'

export interface PitchEditorProps {
  clip: AudioClip
  sourceAsset: AudioAsset | undefined
  projectId: string
  bpm: number
  projectClipIds?: ReadonlySet<string>
  disabled?: boolean
  onApply: (result: PitchRenderedEdit, expectedClip: AudioClip, signal?: AbortSignal) => Promise<void>
  onReset: (expectedClip: AudioClip) => void
  onBusyChange?: (busy: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
}

const ROW_HEIGHT = 18
const KEY_WIDTH = 44
const RULER_HEIGHT = 22
const INPUT_SELECTOR = 'input,textarea,select,[contenteditable="true"]'
const ROOT_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const FORMANT_COMBINATION_PROBLEM = '피치와 포먼트 조합의 내부 보정 범위가 ±1200센트를 넘습니다. 포먼트 이동을 줄이거나 보존을 꺼 주세요.'
const sourceIdFor = (clip: AudioClip) => clip.pitch?.sourceAssetId ?? clip.assetId
const centsLabel = (cents: number) => `${cents > 0 ? '+' : ''}${Number(cents.toFixed(1))} ct`
const timeLabel = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}` : `${Number(seconds.toFixed(2))} s`
const durationFor = (asset: AudioAsset | undefined, clip: AudioClip) => asset?.buffer.duration ?? (clip.pitch ? clip.pitch.analysis.sourceFrames / clip.pitch.analysis.sampleRate : 0)
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

async function digest(asset: AudioAsset): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('원본 검증에는 HTTPS 또는 localhost 환경이 필요합니다.')
  const hash = await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer())
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

function problemFor(asset: AudioAsset | undefined): string | null {
  if (!asset) return '편집할 원본 오디오를 찾을 수 없습니다.'
  if (asset.buffer.duration > PITCH_LIMITS.maxDurationSeconds) return `첫 버전은 원본 파일 ${PITCH_LIMITS.maxDurationSeconds}초까지 분석할 수 있습니다. 짧은 오디오 파일을 가져와 주세요.`
  if (asset.buffer.numberOfChannels < 1 || asset.buffer.numberOfChannels > PITCH_LIMITS.maxChannels) return '모노 또는 스테레오 원본을 선택해 주세요.'
  if (asset.buffer.sampleRate < PITCH_LIMITS.minSampleRate || asset.buffer.sampleRate > PITCH_LIMITS.maxSampleRate) return '이 원본의 샘플레이트는 아직 지원하지 않습니다.'
  return null
}

/** A source-aware, non-destructive editor. Audio is committed only after rendering. */
export function PitchEditor({ clip, sourceAsset, projectId, bpm, projectClipIds, disabled = false, onApply, onReset, onBusyChange, onDirtyChange }: PitchEditorProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ document: null, dirty: false })
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const selectedRef = useRef(selected); selectedRef.current = selected
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] })
  const [phase, setPhase] = useState<'idle' | 'analyzing' | 'rendering'>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [viewportWidth, setViewportWidth] = useState(700)
  const [inputCents, setInputCents] = useState('0')
  const skipCentsBlur = useRef(false)
  const centsEditIds = useRef<ReadonlySet<string> | null>(null)
  const [inputFormants, setInputFormants] = useState('0')
  const skipFormantsBlur = useRef(false)
  const formantEditIds = useRef<ReadonlySet<string> | null>(null)
  const [correctionRoot, setCorrectionRoot] = useState(() => readPitchCorrectionSettings(projectId).root)
  const [correctionScale, setCorrectionScale] = useState<PitchCorrectionScale>(() => readPitchCorrectionSettings(projectId).scale)
  const [correctionStrength, setCorrectionStrength] = useState(() => String(readPitchCorrectionSettings(projectId).strength))
  const [skipUncertain, setSkipUncertain] = useState(() => readPitchCorrectionSettings(projectId).skipUncertain)
  const [otherDrafts, setOtherDrafts] = useState(0)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const task = useRef<{ controller: AbortController; generation: number } | null>(null)
  const generation = useRef(0)
  const callbacks = useRef({ onBusyChange, onDirtyChange }); callbacks.current = { onBusyChange, onDirtyChange }
  const context = useRef({ clip, projectId, bpm }); context.current = { clip, projectId, bpm }
  const gesture = useRef<{ pointerId: number; y: number; original: Snapshot; ids: ReadonlySet<string>; element: HTMLElement; clipId: string; projectId: string } | null>(null)
  const rangeStart = Math.max(0, clip.offsetSeconds)
  const rangeEnd = Math.max(rangeStart, Math.min(durationFor(sourceAsset, clip), rangeStart + clip.lengthBeats * 60 / bpm))
  const rangeDuration = Math.max(0.001, rangeEnd - rangeStart)
  const document = snapshot.document
  const busy = phase !== 'idle'
  const locked = disabled || busy
  const sourceProblem = problemFor(sourceAsset)

  useEffect(() => {
    const settings = readPitchCorrectionSettings(projectId)
    setCorrectionRoot(settings.root); setCorrectionScale(settings.scale)
    setCorrectionStrength(String(settings.strength)); setSkipUncertain(settings.skipUncertain)
  }, [projectId])

  function rememberCorrectionOptions(patch: Partial<PitchCorrectionOptions>) {
    rememberPitchCorrectionSettings(projectId, { ...readPitchCorrectionSettings(projectId), ...patch })
  }

  function notifyDrafts() {
    if (pitchDraftProjectId() !== context.current.projectId) return
    setOtherDrafts([...drafts.keys()].filter(id => id !== context.current.clip.id).length)
    callbacks.current.onDirtyChange?.(drafts.size > 0)
  }

  function rememberDraft(next: Snapshot) {
    const c = context.current
    if (pitchDraftProjectId() !== c.projectId) return
    if (next.dirty && next.document) {
      drafts.set(c.clip.id, { base: c.clip.pitch, sourceId: sourceIdFor(c.clip), offset: c.clip.offsetSeconds, length: c.clip.lengthBeats, bpm: c.bpm, name: c.clip.name, snapshot: next, past: [...history.current.past], future: [...history.current.future], selection: [...selectedRef.current] })
    } else drafts.delete(c.clip.id)
    notifyDrafts()
  }

  function update(nextDocument: PitchEditDocument | null, dirty: boolean, record = true) {
    const before = snapshotRef.current
    if (nextDocument === before.document && dirty === before.dirty) return
    if (record) {
      history.current.past = [...history.current.past.slice(-19), before]
      history.current.future = []
    }
    const next = { document: nextDocument, dirty }
    snapshotRef.current = next
    setSnapshot(next)
    rememberDraft(next)
  }

  function cancelTask() {
    generation.current++
    task.current?.controller.abort()
    task.current = null
    setPhase('idle')
    setProgress(0)
    callbacks.current.onBusyChange?.(false)
  }

  function cancelGesture() {
    const drag = gesture.current
    if (!drag) return
    gesture.current = null
    drag.element.removeAttribute('data-daw-gesture')
    if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
    setDragging(false)
    if (drag.clipId === context.current.clip.id && drag.projectId === context.current.projectId) update(drag.original.document, drag.original.dirty, false)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => setViewportWidth(entries[0]?.contentRect.width ?? 700))
    observer.observe(el)
    setViewportWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    cancelTask()
    cancelGesture()
    enterPitchDraftProject(projectId)
    if (projectClipIds) for (const id of drafts.keys()) if (!projectClipIds.has(id)) drafts.delete(id)
    const saved = drafts.get(clip.id)
    const cached = saved && matchesPitchDraft(saved, clip, bpm) ? saved : null
    if (saved && !cached) drafts.delete(clip.id)
    const initial = clip.pitch ? scopeSegments(clip.pitch, rangeStart, rangeEnd, uid) : null
    const next = cached ? scopePitchSnapshot(cached.snapshot, rangeStart, rangeEnd, uid) : { document: initial, dirty: false }
    snapshotRef.current = next
    setSnapshot(next)
    history.current = cached ? { past: [...cached.past], future: [...cached.future] } : { past: [], future: [] }
    const ids = new Set(cached?.selection ?? [])
    selectedRef.current = ids
    setSelected(ids)
    setError(saved && !cached ? pitchDraftConflictMessage(saved, clip) : '')
    setMessage(cached ? '이 리전의 미적용 편집을 복원했습니다.' : '')
    if (cached) rememberDraft(next)
    else notifyDrafts()
    // Only an applied-document/source change resets local history. The view effect below
    // also preserves Redo after local Undo has returned to a clean, uncached snapshot.
  }, [projectId, clip.id, clip.pitch, sourceAsset?.id])

  useEffect(() => {
    cancelTask()
    cancelGesture()
    const next = scopePitchSnapshot(snapshotRef.current, rangeStart, rangeEnd, uid)
    update(next.document, next.dirty, false)
  }, [rangeStart, rangeEnd])

  useEffect(() => {
    if (pitchDraftProjectId() !== projectId || !projectClipIds) return
    for (const id of drafts.keys()) if (!projectClipIds.has(id)) drafts.delete(id)
    notifyDrafts()
  }, [projectId, projectClipIds])

  useEffect(() => () => {
    generation.current++
    task.current?.controller.abort()
    const drag = gesture.current
    if (drag) {
      drag.element.removeAttribute('data-daw-gesture')
      const cached = drafts.get(drag.clipId)
      if (pitchDraftProjectId() === drag.projectId) {
        if (drag.original.dirty && cached) drafts.set(drag.clipId, { ...cached, snapshot: drag.original })
        else drafts.delete(drag.clipId)
        callbacks.current.onDirtyChange?.(drafts.size > 0)
      }
    }
    callbacks.current.onBusyChange?.(false)
  }, [])

  useEffect(() => {
    const blur = () => cancelGesture()
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [])

  const visibleNotes = useMemo(() => document?.segments.filter(note => note.end > rangeStart + 1e-8 && note.start < rangeEnd - 1e-8) ?? [], [document, rangeStart, rangeEnd])
  const editableVisibleIds = useMemo(() => document ? visibleSelectionIds(document, new Set(visibleNotes.map(note => note.id)), rangeStart, rangeEnd) : new Set<string>(), [document, visibleNotes, rangeStart, rangeEnd])
  const editableNotes = useMemo(() => visibleNotes.filter(note => editableVisibleIds.has(note.id)), [visibleNotes, editableVisibleIds])
  const selectedNotes = useMemo(() => editableNotes.filter(note => selected.has(note.id)), [editableNotes, selected])
  const selectedVisibleIds = useMemo(() => new Set(selectedNotes.map(note => note.id)), [selectedNotes])
  const blockedBoundaryNotes = visibleNotes.length - editableNotes.length
  const noteRange = useMemo(() => {
    const pitches = (document?.analysis.notes ?? []).filter(note => note.end > rangeStart && note.start < rangeEnd).map(note => note.midi)
    const min = pitches.length ? Math.min(...pitches) : 48
    const max = pitches.length ? Math.max(...pitches) : 72
    return { low: Math.max(0, Math.floor(min) - 14), high: Math.min(127, Math.ceil(max) + 14), center: (min + max) / 2 }
  }, [document?.analysis, rangeStart, rangeEnd])
  const rows = noteRange.high - noteRange.low + 1
  const gridWidth = Math.max(200, viewportWidth - KEY_WIDTH - 2) * zoom
  const pixelsPerSecond = gridWidth / rangeDuration
  const height = rows * ROW_HEIGHT
  const rawCurve = useMemo(() => document ? pitchCurvePath(document, rangeStart, rangeEnd, pixelsPerSecond, noteRange.high, ROW_HEIGHT, false) : '', [document, rangeStart, rangeEnd, pixelsPerSecond, noteRange.high])
  const editedCurve = useMemo(() => document ? pitchCurvePath(document, rangeStart, rangeEnd, pixelsPerSecond, noteRange.high, ROW_HEIGHT, true) : '', [document, rangeStart, rangeEnd, pixelsPerSecond, noteRange.high])
  const commonShift = selectedNotes.length && document ? (selectedNotes.every(note => segmentShift(document, note.id) === segmentShift(document, selectedNotes[0].id)) ? segmentShift(document, selectedNotes[0].id) : null) : null
  const commonFormantShift = selectedNotes.length && document ? (selectedNotes.every(note => segmentFormantShift(document, note.id) === segmentFormantShift(document, selectedNotes[0].id)) ? segmentFormantShift(document, selectedNotes[0].id) : null) : null
  const canMerge = !!document && !!mergeCandidate(document, selectedVisibleIds)
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60].find(value => value * pixelsPerSecond >= 65) ?? 60
  const tickCount = Math.ceil(rangeDuration / step)
  const changedNotes = document?.segments.filter(note => segmentShift(document, note.id) !== 0 || segmentFormantShift(document, note.id) !== 0).length ?? 0
  const pitchChangedNotes = document?.segments.filter(note => segmentShift(document, note.id) !== 0).length ?? 0
  const formantChangedNotes = document?.segments.filter(note => segmentFormantShift(document, note.id) !== 0).length ?? 0
  const largeFormantMove = document?.segments.some(note => Math.abs(segmentFormantShift(document, note.id)) > 600 || (document.preserveFormants && Math.abs(segmentShift(document, note.id)) > 600)) ?? false
  const formantProblem = document && hasUnsupportedFormantCombination(document) ? FORMANT_COMBINATION_PROBLEM : null
  const validStrength = correctionStrength.trim() !== '' && Number.isFinite(Number(correctionStrength)) && Number(correctionStrength) >= 0 && Number(correctionStrength) <= 100

  useEffect(() => setInputCents(commonShift === null ? '' : String(commonShift)), [commonShift, selected])
  useEffect(() => setInputFormants(commonFormantShift === null ? '' : String(commonFormantShift)), [commonFormantShift, selected])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = Math.max(0, (noteRange.high - noteRange.center) * ROW_HEIGHT - el.clientHeight / 2 + RULER_HEIGHT)
  }, [document?.analysis, noteRange.high, noteRange.center])

  useEffect(() => {
    const el = scrollRef.current, note = selectedNotes[0]
    if (!el || !note || !document || gesture.current) return
    const x = KEY_WIDTH + (note.start - rangeStart) * pixelsPerSecond
    const y = RULER_HEIGHT + (noteRange.high - note.midi - segmentShift(document, note.id) / 100) * ROW_HEIGHT
    if (x < el.scrollLeft + KEY_WIDTH) el.scrollLeft = Math.max(0, x - KEY_WIDTH - 5)
    else if (x + 15 > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth + 25
    if (y < el.scrollTop + RULER_HEIGHT) el.scrollTop = Math.max(0, y - RULER_HEIGHT - 5)
    else if (y + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_HEIGHT - el.clientHeight + 5
  }, [selectedNotes, document, noteRange.high, pixelsPerSecond, rangeStart])

  async function analyze() {
    if (locked || sourceProblem || !sourceAsset || snapshotRef.current.dirty) return
    const controller = new AbortController(), id = ++generation.current
    task.current = { controller, generation: id }
    setPhase('analyzing'); setProgress(0); setError(''); setMessage('')
    callbacks.current.onBusyChange?.(true)
    try {
      const sourceHash = await digest(sourceAsset)
      if (id !== generation.current || controller.signal.aborted) return
      if (clip.pitch && sourceHash !== clip.pitch.sourceHash) throw new Error('원본 파일이 저장된 피치 분석과 다릅니다. 원본을 확인한 뒤 다시 열어 주세요.')
      const channels = Array.from({ length: sourceAsset.buffer.numberOfChannels }, (_, channel) => sourceAsset.buffer.getChannelData(channel))
      const analysis = await analyzePitchInWorker(channels, sourceAsset.buffer.sampleRate, { signal: controller.signal, onProgress: value => { if (id === generation.current) setProgress(value) } })
      if (id !== generation.current || controller.signal.aborted) return
      const next = scopeSegments({ version: 2, sourceAssetId: sourceAsset.id, sourceHash, rendererId: PITCH_RENDERER_ID, analysis, segments: analysis.notes.map(note => ({ ...note })), shifts: {}, preserveFormants: false, formantShifts: {} }, rangeStart, rangeEnd, uid)
      update(next, true)
      setSelected(new Set())
      setMessage(analysis.notes.length ? `${analysis.notes.length}개 음표를 분석했습니다. 편집 적용을 누르면 분석과 변경값이 프로젝트에 저장됩니다.` : '뚜렷한 단선율 음표를 찾지 못했습니다. 보컬이나 독주 음원을 확인해 주세요.')
    } catch (failure) {
      if (id === generation.current && !isAbort(failure)) setError(failure instanceof Error ? failure.message : '피치 분석에 실패했습니다.')
    } finally {
      if (id === generation.current) { task.current = null; setPhase('idle'); callbacks.current.onBusyChange?.(false) }
    }
  }

  async function apply() {
    const current = snapshotRef.current
    if (locked || sourceProblem || !sourceAsset || !current.document || !current.dirty) return
    // Recheck after an input blur may have committed newer settings than the button render.
    if (hasUnsupportedFormantCombination(current.document)) { setMessage(FORMANT_COMBINATION_PROBLEM); return }
    const expectedClip = clip, controller = new AbortController(), id = ++generation.current
    task.current = { controller, generation: id }
    setPhase('rendering'); setProgress(0); setError(''); setMessage('')
    callbacks.current.onBusyChange?.(true)
    try {
      if (await digest(sourceAsset) !== current.document.sourceHash) throw new Error('원본 파일이 분석 당시와 다릅니다. 편집을 적용하지 않았습니다.')
      if (id !== generation.current || controller.signal.aborted) return
      const channels = Array.from({ length: sourceAsset.buffer.numberOfChannels }, (_, channel) => sourceAsset.buffer.getChannelData(channel))
      const rendered = await renderPitchInWorker(channels, sourceAsset.buffer.sampleRate, current.document.segments, current.document.shifts, { signal: controller.signal, settings: { preserveFormants: current.document.preserveFormants, formantShifts: current.document.formantShifts }, onProgress: value => { if (id === generation.current) setProgress(value) } })
      if (id !== generation.current || controller.signal.aborted) return
      await onApply({ document: { ...current.document, rendererId: PITCH_RENDERER_ID }, channels: rendered, sampleRate: sourceAsset.buffer.sampleRate }, expectedClip, controller.signal)
      if (id !== generation.current || controller.signal.aborted) return
      history.current = { past: [], future: [] }
      update(current.document, false, false)
      setMessage('편집을 적용했습니다. DAW에서 재생하면 보정된 소리가 나옵니다.')
    } catch (failure) {
      if (id === generation.current && !isAbort(failure)) setError(failure instanceof Error ? failure.message : '피치 편집을 적용하지 못했습니다.')
    } finally {
      if (id === generation.current) { task.current = null; setPhase('idle'); callbacks.current.onBusyChange?.(false) }
    }
  }

  function visibleSelection(current: PitchEditDocument, ids: ReadonlySet<string> = selectedRef.current): ReadonlySet<string> {
    return visibleSelectionIds(current, ids, rangeStart, rangeEnd)
  }

  function changeCents(value: number, absolute = false, ids?: ReadonlySet<string>) {
    const current = snapshotRef.current.document
    if (locked || !current) return
    const next = shiftSegments(current, visibleSelection(current, ids), value, absolute)
    if (next !== current) { update(next, true); setError(''); setMessage('') }
  }

  function changeFormants(value: number, absolute = false, ids?: ReadonlySet<string>) {
    const current = snapshotRef.current.document
    if (locked || !current) return
    const next = shiftFormants(current, visibleSelection(current, ids), value, absolute)
    if (next !== current) { update(next, true); setError(''); setMessage('포먼트 이동을 변경했습니다. 편집 적용 후 소리에 반영됩니다.') }
  }

  function commitCents() {
    const ids = centsEditIds.current ?? selectedVisibleIds
    centsEditIds.current = null
    if (skipCentsBlur.current) { skipCentsBlur.current = false; return }
    if (!inputCents.trim() || !Number.isFinite(Number(inputCents))) { setInputCents(commonShift === null ? '' : String(commonShift)); return }
    const value = Math.max(PITCH_LIMITS.minCents, Math.min(PITCH_LIMITS.maxCents, Math.round(Number(inputCents) * 10) / 10))
    setInputCents(String(value))
    changeCents(value, true, ids)
  }

  function commitFormants() {
    const ids = formantEditIds.current ?? selectedVisibleIds
    formantEditIds.current = null
    if (skipFormantsBlur.current) { skipFormantsBlur.current = false; return }
    if (!inputFormants.trim() || !Number.isFinite(Number(inputFormants))) { setInputFormants(commonFormantShift === null ? '' : String(commonFormantShift)); return }
    const value = Math.max(PITCH_LIMITS.minFormantCents, Math.min(PITCH_LIMITS.maxFormantCents, Math.round(Number(inputFormants) * 10) / 10))
    setInputFormants(String(value))
    changeFormants(value, true, ids)
  }

  function changeFormantPreservation(preserveFormants: boolean) {
    const current = snapshotRef.current.document
    if (locked || !current || current.preserveFormants === preserveFormants) return
    update({ ...current, preserveFormants }, true)
    setError(''); setMessage('포먼트 보존 설정을 변경했습니다. 편집 적용 후 소리에 반영됩니다.')
  }

  function correctSelection() {
    const current = snapshotRef.current.document
    if (locked || !current || !validStrength) return
    const strength = Number(correctionStrength)
    const result = correctSelectedPitch(current, visibleSelection(current), { root: correctionRoot, scale: correctionScale, strength, skipUncertain })
    if (result.document !== current) update(result.document, true)
    setError('')
    const summary = strength === 0 ? '보정 강도가 0%여서 음표를 변경하지 않았습니다.' : result.changed ? `현재 중심음 기준 ${result.changed}개 음표를 ${strength}% 보정했습니다. 편집 적용 후 소리에 반영됩니다.` : '선택한 음표는 변경되지 않았습니다.'
    setMessage(`${result.limited ? `${result.limited}개 음표는 ±1200 ct 한도로 목표 음에 도달할 수 없습니다. ` : ''}${summary}${result.skipped ? ` 신뢰도 75% 미만 ${result.skipped}개 제외.` : ''}`)
  }

  function discard() {
    if (locked) return
    history.current = { past: [], future: [] }
    update(clip.pitch ? scopeSegments(clip.pitch, rangeStart, rangeEnd, uid) : null, false, false)
    setSelected(new Set()); setError(''); setMessage('미적용 변경을 취소했습니다.')
  }

  function undoDraft(redo = false): boolean {
    if (locked) return true
    const from = redo ? history.current.future : history.current.past
    const next = from.pop()
    if (!next) return false
    const to = redo ? history.current.past : history.current.future
    to.push(snapshotRef.current)
    const scoped = scopePitchSnapshot(next, rangeStart, rangeEnd, uid)
    update(scoped.document, scoped.dirty, false)
    setMessage(redo ? '미적용 편집을 다시 실행했습니다.' : '미적용 편집을 되돌렸습니다.')
    return true
  }

  function splitSelected() {
    const current = snapshotRef.current.document
    if (locked || !current || selectedNotes.length !== 1) return
    const note = selectedNotes[0]
    const next = splitSegment(current, note.id, (note.start + note.end) / 2, uid())
    if (next !== current) { update(next, true); setMessage('선택 음표를 가운데에서 나눴습니다.') }
  }

  function mergeSelected() {
    const current = snapshotRef.current.document
    if (locked || !current) return
    const ids = visibleSelection(current)
    const next = mergeSegments(current, ids)
    if (next !== current) {
      const first = current.segments.find(note => ids.has(note.id))!
      setSelected(new Set([first.id])); update(scopeSegments(next, rangeStart, rangeEnd, uid), true); setMessage('인접 음표를 합쳤습니다.')
    }
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, note: PitchNote) {
    if (event.button !== 0 || locked || !document || !editableVisibleIds.has(note.id)) return
    event.preventDefault(); event.stopPropagation()
    let ids: Set<string>
    if (event.metaKey || event.ctrlKey) {
      ids = new Set(selectedRef.current)
      if (ids.has(note.id)) ids.delete(note.id); else ids.add(note.id)
    } else if (event.shiftKey && selectedRef.current.size) {
      const first = editableNotes.findIndex(item => selectedRef.current.has(item.id))
      const last = editableNotes.findIndex(item => item.id === note.id)
      ids = first < 0 ? new Set([note.id]) : new Set(editableNotes.slice(Math.min(first, last), Math.max(first, last) + 1).map(item => item.id))
    } else ids = selectedRef.current.has(note.id) ? new Set(selectedRef.current) : new Set([note.id])
    ids = new Set(visibleSelection(document, ids))
    selectedRef.current = ids; setSelected(ids)
    if (!ids.has(note.id)) return
    // Blurring a numeric editor commits its pinned selection before the drag snapshot.
    event.currentTarget.focus({ preventScroll: true })
    gesture.current = { pointerId: event.pointerId, y: event.clientY, original: snapshotRef.current, ids, element: event.currentTarget, clipId: clip.id, projectId }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.setAttribute('data-daw-gesture', '')
    setDragging(true)
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = gesture.current
    if (!drag || drag.pointerId !== event.pointerId || !drag.original.document) return
    const raw = (drag.y - event.clientY) / ROW_HEIGHT * 100
    const delta = event.altKey ? Math.round(raw) : Math.round(raw / 100) * 100
    const next = shiftSegments(drag.original.document, visibleSelection(drag.original.document, drag.ids), delta)
    update(next, next !== drag.original.document || drag.original.dirty, false)
  }

  function pointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = gesture.current
    if (!drag || drag.pointerId !== event.pointerId) return
    gesture.current = null
    drag.element.removeAttribute('data-daw-gesture')
    if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
    setDragging(false)
    if (snapshotRef.current.document !== drag.original.document) {
      history.current.past = [...history.current.past.slice(-19), drag.original]
      history.current.future = []
      rememberDraft(snapshotRef.current)
    }
  }

  function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest(INPUT_SELECTOR)) {
      if (event.key === 'Escape') target.blur()
      event.stopPropagation()
      return
    }
    const command = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (gesture.current) cancelGesture()
      else if (busy) { cancelTask(); setMessage('작업을 취소했습니다. 원본과 적용된 편집은 유지됩니다.') }
      else setSelected(new Set())
      return
    }
    if (command && event.key.toLowerCase() === 'z') {
      if (undoDraft(event.shiftKey)) { event.preventDefault(); event.stopPropagation() }
      return
    }
    // Enter activates buttons/details locally; the host captures Space transport first.
    if (!command && target.closest('button:not(.pe-note),summary')) { event.stopPropagation(); return }
    // Transport and project saving remain host commands; editing keys belong here.
    if (event.key === ' ' || (command && event.key.toLowerCase() === 's')) return
    event.stopPropagation()
    if (locked) { if (event.key !== 'Tab') event.preventDefault(); return }
    if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(editableVisibleIds)); return }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); changeCents((event.key === 'ArrowUp' ? 1 : -1) * (event.altKey ? 1 : event.shiftKey ? 10 : 100)); return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const current = editableNotes.findIndex(note => selected.has(note.id))
      const index = Math.max(0, Math.min(editableNotes.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))
      if (editableNotes[index]) setSelected(new Set([editableNotes[index].id]))
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); changeCents(0, true) }
  }

  const statusText = error || sourceProblem || formantProblem || message || (otherDrafts ? `다른 리전 ${otherDrafts}개에도 미적용 편집이 있습니다.` : '↑↓ 반음 · Shift 10 ct · Alt 1 ct · Ctrl/⌘ 다중 선택 · 적용 후 DAW에서 재생')
  const style = { '--pe-row-height': `${ROW_HEIGHT}px`, '--pe-key-width': `${KEY_WIDTH}px` } as CSSProperties
  return <section ref={rootRef} className="pitch-editor" style={style} tabIndex={0} data-keyboard-scope="pitch" aria-label="음표 피치 편집기" onKeyDown={keyDown}>
    <div className="pe-toolbar">
      <div className="pe-identity"><Icon name="note" size={14}/><strong>피치 편집</strong><span className="pe-badge">단선율</span></div>
      <div className="pe-actions">
        <button className="pe-button" onClick={() => void analyze()} disabled={locked || !!sourceProblem || snapshot.dirty} title={document ? '원본을 다시 분석합니다. 현재 소리는 편집 적용 전까지 유지됩니다.' : '원본 오디오에서 음표와 피치 곡선을 분석'}><Icon name="wave" size={12}/>{document ? '다시 분석' : '음표 분석'}</button>
        <button className="pe-button pe-apply" disabled={locked || !!sourceProblem || !!formantProblem || !snapshot.dirty || !document} title={formantProblem ?? undefined} onClick={() => void apply()}><Icon name="check" size={12}/>편집 적용</button>
        {busy ? <button className="pe-button" onClick={() => { cancelTask(); setMessage('작업을 취소했습니다.') }}><Icon name="close" size={12}/>취소</button> : <button className="pe-button pe-text" disabled={!snapshot.dirty || disabled} onClick={discard}>변경 취소</button>}
        <button className="pe-button pe-text" disabled={locked || !clip.pitch} onClick={() => onReset(clip)} title="적용한 피치 편집과 분석을 해제하고 원본 리전으로 복원">원본 복원</button>
      </div>
      <div className={`pe-state ${snapshot.dirty ? 'is-dirty' : ''}`} aria-live="polite">{busy ? `${phase === 'analyzing' ? '분석' : '렌더'} ${Math.round(progress * 100)}%` : snapshot.dirty ? '미적용 변경' : clip.pitch ? '프로젝트에 적용됨' : '원본'}</div>
    </div>
    {busy && <div className="pe-progress" role="progressbar" aria-label={phase === 'analyzing' ? '피치 분석' : '피치 렌더링'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${Math.max(1, Math.min(100, progress * 100))}%` }}/></div>}
    <div className="pe-workspace">
      <div className={`pe-scroll ${dragging ? 'is-dragging' : ''}`} ref={scrollRef} aria-label="피치 격자" onPointerDown={event => { if (event.target === event.currentTarget) { setSelected(new Set()); rootRef.current?.focus({ preventScroll: true }) } }}>
        {document ? <div className="pe-sheet" style={{ width: gridWidth + KEY_WIDTH, height: height + RULER_HEIGHT }}>
          <div className="pe-ruler"><span className="pe-corner">음높이</span>{Array.from({ length: tickCount + 1 }, (_, index) => <span key={index} className="pe-tick" style={{ left: KEY_WIDTH + index * step * pixelsPerSecond }}>{timeLabel(index * step)}</span>)}</div>
          <div className="pe-grid" style={{ top: RULER_HEIGHT, height, width: gridWidth + KEY_WIDTH }} onPointerDown={event => { if (event.button === 0) { setSelected(new Set()); rootRef.current?.focus({ preventScroll: true }) } }}>
            {Array.from({ length: rows }, (_, row) => { const midi = noteRange.high - row, black = [1, 3, 6, 8, 10].includes(midi % 12); return <div key={midi} className={`pe-row ${black ? 'is-black' : ''} ${midi % 12 === 0 ? 'is-octave' : ''}`} style={{ top: row * ROW_HEIGHT }}><span className="pe-key">{pitchName(midi)}</span></div> })}
            {Array.from({ length: tickCount + 1 }, (_, index) => <i key={index} className="pe-time-line" style={{ left: KEY_WIDTH + index * step * pixelsPerSecond }}/>) }
            {visibleNotes.map(note => {
              const shift = segmentShift(document, note.id)
              const formantShift = segmentFormantShift(document, note.id)
              const uncertain = note.confidence < CORRECTION_CONFIDENCE_THRESHOLD
              const boundaryLocked = !editableVisibleIds.has(note.id)
              const left = (Math.max(rangeStart, note.start) - rangeStart) * pixelsPerSecond
              const width = Math.max(3, (Math.min(rangeEnd, note.end) - Math.max(rangeStart, note.start)) * pixelsPerSecond)
              return <button key={note.id} tabIndex={selectedNotes[0]?.id === note.id ? 0 : -1} className={`pe-note ${selectedVisibleIds.has(note.id) ? 'is-selected' : ''} ${shift !== 0 || formantShift !== 0 ? 'is-edited' : ''} ${shift === 0 && formantShift !== 0 ? 'is-formant-only' : ''} ${uncertain ? 'is-uncertain' : ''} ${boundaryLocked ? 'is-boundary-locked' : ''}`} style={{ left: KEY_WIDTH + left, top: (noteRange.high - note.midi - shift / 100) * ROW_HEIGHT + 2, width, height: ROW_HEIGHT - 4 }} disabled={locked || boundaryLocked} aria-label={`${pitchName(Math.round(note.midi + shift / 100))}, ${timeLabel(note.start - rangeStart)}, 피치 ${centsLabel(shift)}, 포먼트 ${centsLabel(formantShift)}${uncertain ? ', 검출 확인 필요' : ''}${boundaryLocked ? ', 음표 수 한도로 경계 음표 편집 불가' : ''}`} aria-pressed={selectedVisibleIds.has(note.id)} title={`${pitchName(Math.round(note.midi))} · 피치 ${centsLabel(shift)} · 포먼트 ${centsLabel(formantShift)} · 신뢰도 ${Math.round(note.confidence * 100)}%\n${boundaryLocked ? '음표 수 한도로 경계 음표를 편집할 수 없습니다. 리전 범위를 넓히거나 음표를 합쳐 주세요.' : '위아래 드래그: 반음 · Alt: 센트 정밀 이동'}`} onPointerDown={event => pointerDown(event, note)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture() }} onFocus={() => { if (!boundaryLocked && !selectedRef.current.has(note.id) && !gesture.current) { selectedRef.current = new Set([note.id]); setSelected(selectedRef.current) } }} onDoubleClick={() => { if (!locked && !boundaryLocked) { setSelected(new Set([note.id])); const next = shiftSegments(document, visibleSelection(document, new Set([note.id])), 0, true); if (next !== document) update(next, true) } }}>
                {width > 29 && <span>{pitchName(Math.round(note.midi + shift / 100))}</span>}{width > 70 && shift !== 0 && <small>{centsLabel(shift)}</small>}{formantShift !== 0 && width > 40 && <small className="pe-formant-mark" aria-hidden="true">F</small>}{uncertain && width > 18 && <i aria-hidden="true">?</i>}
              </button>
            })}
            <svg className="pe-curves" width={gridWidth} height={height} style={{ left: KEY_WIDTH }} aria-hidden="true"><path className="pe-original-curve" d={rawCurve}/><path className="pe-edited-curve" d={editedCurve}/></svg>
          </div>
          {!visibleNotes.length && <div className="pe-no-notes">이 리전에서 편집할 음표를 찾지 못했습니다.</div>}
        </div> : <div className="pe-empty"><Icon name="wave" size={28}/><strong>녹음한 소리를 음표처럼 편집</strong><p>음표 분석 후 위아래로 움직이거나 센트 값을 입력하세요.</p><small>보컬·독주용 · 원본 60초 이내 · 모노/스테레오</small></div>}
      </div>
      <aside className="pe-inspector" aria-label="음표 편집 설정">
        <div className="pe-selection-title"><Icon name="inspector" size={12}/><strong>{selectedNotes.length ? `${selectedNotes.length}개 음표 선택` : '음표를 선택하세요'}</strong></div>
        {blockedBoundaryNotes > 0 && <p className="pe-hint pe-formant-caution" role="status">음표 수 한도로 경계 음표를 편집할 수 없습니다. 리전 범위를 넓히거나 음표를 합쳐 주세요.</p>}
        <label className="pe-cents-label">원본에서 이동 <span>cents</span><input aria-label="선택 음표 피치 이동 센트" type="number" min={PITCH_LIMITS.minCents} max={PITCH_LIMITS.maxCents} step={0.1} value={inputCents} placeholder={selectedNotes.length > 1 ? '서로 다름' : '0'} disabled={locked || !selectedNotes.length} onFocus={() => { centsEditIds.current = selectedVisibleIds }} onChange={event => setInputCents(event.target.value)} onBlur={commitCents} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }; if (event.key === 'Escape') { event.preventDefault(); skipCentsBlur.current = true; setInputCents(commonShift === null ? '' : String(commonShift)); event.currentTarget.blur() } }}/></label>
        <div className="pe-step-buttons"><button disabled={locked || !selectedNotes.length} onClick={() => changeCents(-100)} aria-label="선택 음표 반음 내리기"><Icon name="minus" size={11}/>반음</button><button disabled={locked || !selectedNotes.length} onClick={() => changeCents(100)} aria-label="선택 음표 반음 올리기"><Icon name="plus" size={11}/>반음</button></div>
        <div className="pe-note-tools"><button disabled={locked || selectedNotes.length !== 1 || selectedNotes[0].end - selectedNotes[0].start < PITCH_LIMITS.minNoteSeconds * 2 || (document?.segments.length ?? 0) >= PITCH_LIMITS.maxNotes} onClick={splitSelected} title="선택 음표를 가운데에서 분할"><Icon name="scissors" size={11}/>분할</button><button disabled={locked || !canMerge} onClick={mergeSelected} title="피치와 포먼트 이동값이 모두 같은 인접 음표를 합칩니다"><Icon name="merge" size={11}/>합치기</button><button disabled={locked || !selectedNotes.length} onClick={() => changeCents(0, true)}><Icon name="undo" size={11}/>피치 초기화</button></div>
        <section className="pe-control-group" aria-label="선택 음표 음정 보정">
          <h3>음정 중심 보정</h3>
          <div className="pe-scale-fields">
            <label>기준음<select aria-label="음정 보정 기준음" value={correctionRoot} disabled={locked || correctionScale === 'chromatic'} title={correctionScale === 'chromatic' ? '반음계는 기준음에 관계없이 모든 반음을 사용합니다.' : '사용할 음계의 기준음을 직접 선택하세요.'} onChange={event => { const root = Number(event.target.value); setCorrectionRoot(root); rememberCorrectionOptions({ root }) }}>{ROOT_NAMES.map((name, index) => <option key={index} value={index}>{name}</option>)}</select></label>
            <label>음계<select aria-label="음정 보정 음계" value={correctionScale} disabled={locked} onChange={event => { const scale = event.target.value as PitchCorrectionScale; setCorrectionScale(scale); rememberCorrectionOptions({ scale }) }}>{PITCH_CORRECTION_SCALES.map(scale => <option key={scale.value} value={scale.value}>{scale.label}</option>)}</select></label>
          </div>
          <label className="pe-strength-label">보정 강도 <input aria-label="음정 보정 강도 퍼센트" type="number" min={0} max={100} step={1} value={correctionStrength} disabled={locked} onChange={event => { const value = event.target.value, strength = Number(value); setCorrectionStrength(value); if (value.trim() && Number.isFinite(strength) && strength >= 0 && strength <= 100) rememberCorrectionOptions({ strength }) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}/><span>%</span></label>
          <label className="pe-check-label"><input type="checkbox" checked={skipUncertain} disabled={locked} onChange={event => { setSkipUncertain(event.target.checked); rememberCorrectionOptions({ skipUncertain: event.target.checked }) }}/>신뢰도 75% 미만 제외</label>
          <button className="pe-button" disabled={locked || !selectedNotes.length || !validStrength} onClick={correctSelection}>선택 음표 보정</button>
          <details className="pe-help"><summary>보정 방식</summary><p>기준음과 음계를 직접 지정합니다. 보정 버튼은 화면 안의 선택 음표만 이동하며, 설정만 바꾸면 음표는 움직이지 않습니다.</p><p>현재 중심음에서 가장 가까운 음계 음으로 강도만큼 이동합니다. 같은 거리면 낮은 음을 고릅니다. 50%를 반복하면 남은 오차의 절반씩 좁혀집니다.</p><p>곡선·비브라토는 유지됩니다. 누적 이동은 원본 기준 ±1200 ct까지여서 목표 음에 못 미칠 수 있습니다. 100 ct = 1반음.</p><p>신뢰도 75% 기준은 검출 휴리스틱이며 정확도를 보장하는 확률이 아닙니다. 적용 후 소리를 확인하세요.</p></details>
        </section>
        <section className="pe-control-group" aria-label="포먼트 설정">
          <h3>포먼트</h3>
          <label className="pe-check-label"><input type="checkbox" checked={document?.preserveFormants ?? false} disabled={locked || !document} onChange={event => changeFormantPreservation(event.target.checked)}/>포먼트 보존 (실험)</label>
          {formantProblem && <p className="pe-hint pe-formant-caution">{formantProblem}</p>}
          <p className="pe-hint">추정 음색 보정입니다. 큰 이동에서 음색·음량이 달라질 수 있습니다.</p>
          {largeFormantMove && <p className="pe-hint pe-formant-caution" role="status">큰 이동이 있습니다. 적용 후 원본과 비교해 음색·음량을 확인하세요.</p>}
          <label className="pe-cents-label">포먼트 이동 <span>cents</span><input aria-label="선택 음표 포먼트 이동 센트" type="number" min={PITCH_LIMITS.minFormantCents} max={PITCH_LIMITS.maxFormantCents} step={0.1} value={inputFormants} placeholder={selectedNotes.length > 1 ? '서로 다름' : '0'} disabled={locked || !selectedNotes.length} onFocus={() => { formantEditIds.current = selectedVisibleIds }} onChange={event => setInputFormants(event.target.value)} onBlur={commitFormants} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }; if (event.key === 'Escape') { event.preventDefault(); skipFormantsBlur.current = true; setInputFormants(commonFormantShift === null ? '' : String(commonFormantShift)); event.currentTarget.blur() } }}/></label>
          <button className="pe-button" disabled={locked || !selectedNotes.length} onClick={() => changeFormants(0, true)}><Icon name="undo" size={11}/>포먼트 초기화</button>
          <details className="pe-help"><summary>음색 이동 · ±1200 ct</summary><p>포먼트는 음색의 공명입니다. 보존을 켜면 원본 음색을 기준으로, 끄면 피치와 함께 이동한 음색을 기준으로 추가 이동합니다.</p><p>보존 설정은 전체 음표에 적용됩니다. 이동값은 선택 음표에만 적용되며 음높이 곡선을 바꾸지 않습니다. F 표시는 포먼트가 변경된 음표입니다.</p><p>포먼트 처리는 실험 기능입니다. 편집 적용 후 소리를 확인하세요.</p></details>
        </section>
        <div className="pe-note-facts">{selectedNotes.length === 1 ? <><span>검출 음 <b>{pitchName(Math.round(selectedNotes[0].midi))}</b></span><span>길이 <b>{timeLabel(selectedNotes[0].end - selectedNotes[0].start)}</b></span><span>신뢰도 <b>{Math.round(selectedNotes[0].confidence * 100)}%</b></span></> : <span>리전 음표 <b>{visibleNotes.length}</b></span>}<span title="원본 전체에서 피치 또는 포먼트 이동값이 있는 음표 수">전체 변경 음표 <b>{changedNotes}</b></span><span>피치 · 포먼트 <b>{pitchChangedNotes} · {formantChangedNotes}</b></span></div>
        <label className="pe-zoom-label"><Icon name="arrowsH" size={12}/>가로 확대<input type="range" aria-label="피치 편집기 가로 확대" min={1} max={8} step={0.25} value={zoom} onChange={event => setZoom(Number(event.target.value))}/><button onClick={() => setZoom(1)} title="전체 리전에 맞춤" aria-label="전체 리전에 맞춤"><Icon name="fit" size={12}/></button></label>
      </aside>
    </div>
    <div className={`pe-footer ${error || sourceProblem || formantProblem ? 'is-error' : ''}`}>
      <span role={error || sourceProblem || formantProblem ? 'alert' : 'status'} title={statusText} data-selectable-text="">{statusText}</span>
      <span className="pe-footer-note">{snapshot.dirty ? '미적용 편집은 이 세션에만 보관됩니다' : '원본 보존 · ±12반음'}</span>
    </div>
  </section>
}
