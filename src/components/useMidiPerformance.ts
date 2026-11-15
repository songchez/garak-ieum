import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AudioEngine, Project } from '../core/types'
import { KEYBOARD_SOURCE, acceptsMidi, liveMidiTrackIds, midiInputOf, midiRecordTrackIds, midiRoutes, noteOffMessage, noteOnMessage, parseMidi } from '../core/midiInput'
import { MidiTake, commitMidiTake, takeSpan, type MidiRecordMode, type MidiTakeResult, type RecordedNote } from '../core/midiRecording'
import { MidiCaptureBuffer, capturePerformance } from '../core/midiCapture'
import { DEFAULT_MUSICAL_TYPING, musicalTypingAction, musicalTypingNoteCode, type MusicalTypingState } from '../core/musicalTyping'
import { shortcutScope } from '../core/input'
import { SUSTAIN_CONTROLLER, isPedalDown } from '../core/sustain'
import { recordingStartBeat } from '../core/recording'
import { getMetronomePrefs } from '../core/metronome'
import { tempoMapOf } from '../core/tempoMap'
import { NativeMidiInputService, WebMidiInputService, midiDeviceDirectory, type MidiInputService, type MidiInputState } from '../audio/MidiInput'
import type { NativeLiveMidi } from '../audio/native/nativeLiveMidi'

/** A growing region drawn while recording. */
export interface MidiRecordingPreview { trackId: string; startBeat: number; endBeat: number; notes: readonly RecordedNote[] }

const MODE_KEY = 'garak.midiRecordMode'
const loadMode = (): MidiRecordMode => { try { return globalThis.localStorage?.getItem(MODE_KEY) === 'replace' ? 'replace' : 'merge' } catch { return 'merge' } }

export interface MidiPerformanceOptions {
  engine: AudioEngine
  project: Project
  focusedTrackId: string | null
  /** App audio recording state: a MIDI take runs alongside an audio pass on armed instrument tracks. */
  audioRecording: boolean
  getProject(): Project
  commit(next: Project, label: string): void
  select(clipIds: string[], trackId: string): void
  notify(message: string): void
}

const EMPTY_STATE: MidiInputState = { access: 'unsupported', devices: [] }

/**
 * Live MIDI for the studio: device service, routes to the engine (I/auto-arm rules), computer-keyboard playing,
 * MIDI recording (alone or with an audio pass) and Capture. docs/MIDI_RECORDING.md.
 */
export function useMidiPerformance(options: MidiPerformanceOptions) {
  const { engine, project, focusedTrackId, audioRecording } = options
  const latest = useRef(options)
  latest.current = options
  const port = engine.liveMidi

  // ---- Devices ------------------------------------------------------------
  const service = useMemo<MidiInputService | null>(() => {
    if (!port) return null
    if (engine.kind === 'native') return new NativeMidiInputService(port as NativeLiveMidi)
    return new WebMidiInputService((source, data, time) => port.send(source, data, time))
  }, [engine, port])
  useEffect(() => () => service?.dispose(), [service])
  const subscribeService = useCallback((listener: () => void) => service?.subscribe(listener) ?? (() => undefined), [service])
  const getServiceState = useCallback(() => service?.getState() ?? EMPTY_STATE, [service])
  const inputState = useSyncExternalStore(subscribeService, getServiceState, getServiceState)
  useEffect(() => { midiDeviceDirectory.publish(inputState.devices) }, [inputState.devices])

  // ---- Routes -------------------------------------------------------------
  const liveIds = useMemo(() => liveMidiTrackIds(project, focusedTrackId), [project, focusedTrackId])
  const routes = useMemo(() => midiRoutes(project, liveIds), [project, liveIds])
  useEffect(() => { port?.setRoutes(routes) }, [port, routes])

  // ---- Musical typing -----------------------------------------------------
  const [typing, setTyping] = useState<{ enabled: boolean } & MusicalTypingState>({ enabled: false, ...DEFAULT_MUSICAL_TYPING })
  const typingRef = useRef(typing)
  typingRef.current = typing
  const keyNotes = useRef(new Map<string, number>())
  const releaseKeys = useCallback(() => {
    for (const pitch of keyNotes.current.values()) port?.send(KEYBOARD_SOURCE, noteOffMessage(pitch))
    keyNotes.current.clear()
  }, [port])
  useEffect(() => {
    if (!port) return
    const down = (event: KeyboardEvent) => {
      const state = typingRef.current
      if (!state.enabled) return
      const scope = shortcutScope(event.target)
      if (scope === 'text' || scope === 'dialog' || scope === 'outside') return
      const action = musicalTypingAction(event, state)
      if (!action) return
      // Musical typing owns these keys while it is on: no app shortcut, no button activation.
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.repeat) return
      if (action.kind === 'control') { setTyping(previous => ({ ...previous, ...action.state })); return }
      if (keyNotes.current.has(action.code)) return
      keyNotes.current.set(action.code, action.pitch)
      port.send(KEYBOARD_SOURCE, noteOnMessage(action.pitch, state.velocity), event.timeStamp)
    }
    const up = (event: KeyboardEvent) => {
      const code = musicalTypingNoteCode(event)
      const pitch = code === undefined ? undefined : keyNotes.current.get(code)
      if (code === undefined || pitch === undefined) return
      keyNotes.current.delete(code)
      event.preventDefault(); event.stopImmediatePropagation()
      port.send(KEYBOARD_SOURCE, noteOffMessage(pitch), event.timeStamp)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', releaseKeys)
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', releaseKeys); releaseKeys() }
  }, [port, releaseKeys])
  const toggleTyping = useCallback((value?: boolean) => {
    setTyping(previous => {
      const enabled = value ?? !previous.enabled
      if (!enabled) releaseKeys()
      return { ...previous, enabled }
    })
  }, [releaseKeys])

  // ---- Recording + capture --------------------------------------------------
  const [mode, setModeState] = useState<MidiRecordMode>(loadMode)
  const setMode = useCallback((next: MidiRecordMode) => { setModeState(next); try { globalThis.localStorage?.setItem(MODE_KEY, next) } catch { /* session only */ } }, [])
  const modeRef = useRef(mode)
  modeRef.current = mode
  const take = useRef<MidiTake | null>(null)
  const capture = useRef(new MidiCaptureBuffer())
  /** Notes held right now (for a take that starts while they are down). */
  const held = useRef(new Map<string, { source: string; channel: number; pitch: number; velocity: number }>())
  /** Sustain pedals down right now, per input and channel. */
  const pedals = useRef(new Map<string, { source: string; channel: number }>())
  const [midiRecording, setMidiRecording] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [previews, setPreviews] = useState<MidiRecordingPreview[]>([])
  const ownTransport = useRef(false)

  useEffect(() => {
    if (!port) return
    return port.subscribe(event => {
      const message = parseMidi(event.data)
      if (message.type === 'noteOn') held.current.set(`${event.source}:${message.channel}:${message.pitch}`, { source: event.source, channel: message.channel, pitch: message.pitch, velocity: message.velocity })
      else if (message.type === 'noteOff') held.current.delete(`${event.source}:${message.channel}:${message.pitch}`)
      else if (message.type === 'controller' && message.controller === SUSTAIN_CONTROLLER) {
        const key = `${event.source}:${message.channel}`
        if (isPedalDown(message.value)) pedals.current.set(key, { source: event.source, channel: message.channel })
        else pedals.current.delete(key)
      }
      if (take.current) take.current.input(event)
      else capture.current.push(event)
    })
  }, [port])

  const refreshPreview = useCallback(() => {
    const active = take.current
    if (!active) { setPreviews(previous => previous.length ? [] : previous); return }
    const now = engine.getSnapshot().beat
    active.tick(now)
    const notes = active.preview(now)
    const end = active.cycle ? active.cycle.end : Math.max(active.reach, now, active.startBeat)
    setPreviews(active.trackIds.map(trackId => ({ trackId, startBeat: active.cycle ? active.cycle.start : active.startBeat, endBeat: end, notes: notes.get(trackId) ?? [] })))
  }, [engine])

  const beginTake = useCallback((trackIds: string[]) => {
    const current = latest.current.getProject()
    const startBeat = engine.getSnapshot().beat
    const cycle = current.loop.enabled && current.loop.endBeat - current.loop.startBeat > 0.001 && startBeat < current.loop.endBeat ? { start: current.loop.startBeat, end: current.loop.endBeat } : null
    const tracks = trackIds.flatMap(id => { const track = current.tracks.find(item => item.id === id); return track ? [{ trackId: id, input: midiInputOf(track) }] : [] })
    if (!tracks.length) return false
    const next = new MidiTake({ startBeat, cycle, tracks })
    for (const note of held.current.values()) next.holdAtStart(note.source, note.channel, note.pitch, note.velocity)
    for (const pedal of pedals.current.values()) next.pedalAtStart(pedal.source, pedal.channel)
    take.current = next
    setMidiRecording(true)
    refreshPreview()
    return true
  }, [engine, refreshPreview])

  const finishTake = useCallback((): MidiTakeResult | null => {
    const active = take.current
    if (!active) return null
    take.current = null
    setMidiRecording(false)
    setPreviews([])
    const result = active.finish(engine.getSnapshot().beat)
    const { getProject, commit, select, notify } = latest.current
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    const committed = commitMidiTake(getProject(), result, { mode: modeRef.current, beatsPerBar: getProject().beatsPerBar, name: `MIDI ${time}` })
    if (!committed.clipIds.length) { notify('녹음된 MIDI 음표가 없습니다.'); return result }
    commit(committed.project, committed.clipIds.length > 1 ? `MIDI 녹음 (${committed.clipIds.length}개 트랙)` : 'MIDI 녹음')
    const first = committed.project.tracks.find(track => track.clips.some(clip => clip.id === committed.clipIds[0]))
    if (first) select(committed.clipIds, first.id)
    return result
  }, [engine])

  // Live preview clock + transport stop ends the take (Space, stop button, project end).
  useEffect(() => {
    if (!midiRecording) return
    const timer = window.setInterval(refreshPreview, 66)
    return () => window.clearInterval(timer)
  }, [midiRecording, refreshPreview])
  useEffect(() => {
    let wasPlaying = engine.getSnapshot().playing
    return engine.subscribe(() => {
      const playing = engine.getSnapshot().playing
      if (wasPlaying && !playing) {
        if (take.current && !latest.current.audioRecording) { finishTake(); ownTransport.current = false }
        port?.panic()
        held.current.clear()
        pedals.current.clear()
      }
      wasPlaying = playing
    })
  }, [engine, port, finishTake])

  // An audio pass (App) records armed instrument tracks too: the take follows App's recording flag.
  useEffect(() => {
    if (audioRecording && !take.current) {
      const ids = midiRecordTrackIds(latest.current.getProject(), latest.current.focusedTrackId).filter(id => latest.current.getProject().tracks.find(t => t.id === id)?.armed)
      if (ids.length) beginTake(ids)
    } else if (!audioRecording && take.current && !ownTransport.current) finishTake()
  }, [audioRecording, beginTake, finishTake])

  /** MIDI-only recording (no armed audio track): count-in, then a take on every armed (or the auto-armed) instrument track. */
  const startRecording = useCallback(async (): Promise<boolean> => {
    if (take.current || preparing) return false
    const current = latest.current.getProject()
    const ids = midiRecordTrackIds(current, latest.current.focusedTrackId)
    if (!ids.length) { latest.current.notify('MIDI를 녹음할 악기 트랙을 선택하거나 녹음 활성화(R)하세요.'); return false }
    setPreparing(true)
    try {
      await engine.resume()
      engine.setProject(latest.current.getProject())
      if (!engine.getSnapshot().playing) {
        engine.seek(recordingStartBeat(current, engine.getSnapshot().beat))
        await engine.play({ countInBars: getMetronomePrefs().countInBars })
      }
      if (!engine.getSnapshot().playing) return false
      ownTransport.current = true
      return beginTake(ids)
    } catch (error) {
      latest.current.notify(`MIDI 녹음을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally { setPreparing(false) }
  }, [engine, preparing, beginTake])

  /** Ends a MIDI-only take; the transport stops like Logic's record button (pause keeps the playhead). */
  const stopRecording = useCallback(() => {
    if (!take.current) return
    finishTake()
    ownTransport.current = false
    if (engine.getSnapshot().playing) engine.pause()
  }, [engine, finishTake])

  /** Capture: the last performance becomes a region on the record target (docs/MIDI_RECORDING.md §캡처). */
  const captureMidi = useCallback(() => {
    const { getProject, focusedTrackId: focused, commit, select, notify } = latest.current
    const current = getProject()
    const trackId = midiRecordTrackIds(current, focused)[0] ?? current.tracks.find(track => track.id === focused && track.kind === 'instrument')?.id
    const track = current.tracks.find(item => item.id === trackId)
    if (!track) { notify('캡처할 악기 트랙을 선택하세요.'); return }
    const input = midiInputOf(track)
    const performance = capturePerformance(capture.current.snapshot(), { bpm: tempoMapOf(current), playheadBeat: engine.getSnapshot().beat, accepts: (source, channel) => acceptsMidi(input, source, channel) })
    if (!performance) { notify('캡처할 최근 연주가 없습니다. 악기 트랙에서 연주한 뒤 다시 시도하세요.'); return }
    const span = takeSpan({ startBeat: performance.startBeat, endBeat: performance.endBeat, cycle: null }, performance.notes, current.beatsPerBar)
    const result: MidiTakeResult = { startBeat: span.start, endBeat: span.end, cycle: null, tracks: [{ trackId: track.id, notes: performance.notes, controllers: performance.controllers, sustain: performance.sustain }] }
    const committed = commitMidiTake(current, result, { mode: modeRef.current, beatsPerBar: current.beatsPerBar, name: 'MIDI 캡처' })
    if (!committed.clipIds.length) { notify('캡처할 음표가 없습니다.'); return }
    capture.current.clear()
    commit(committed.project, 'MIDI 캡처')
    select(committed.clipIds, track.id)
    notify(performance.playing ? '마지막 연주를 연주한 위치에 MIDI 리전으로 만들었습니다.' : '마지막 연주를 재생 커서 위치에 MIDI 리전으로 만들었습니다.')
  }, [engine])

  const subscribeInput = useCallback((listener: (event: { source: string; data: readonly number[] }) => void) => port?.subscribe(listener) ?? (() => undefined), [port])
  // Dev builds only: inject MIDI as if it came from a device (browser tests cannot open Web MIDI headless).
  useEffect(() => {
    if (!import.meta.env.DEV || !port) return
    const target = window as unknown as { __garakMidi?: unknown }
    target.__garakMidi = { inject: (data: number[], source = 'test-device') => port.send(source, data), routes: () => routes, capture: () => capture.current.snapshot().length }
    return () => { delete target.__garakMidi }
  }, [port, routes])

  const panic = useCallback(() => { releaseKeys(); port?.panic(); held.current.clear(); pedals.current.clear() }, [port, releaseKeys])

  return {
    supported: !!port,
    service, inputState, liveTrackIds: liveIds,
    typing, toggleTyping,
    mode, setMode,
    recording: midiRecording, preparing, previews,
    startRecording, stopRecording, captureMidi, panic,
    /** Every stamped live message (activity light). */
    subscribeInput,
    /** Dev/test hook: inject a raw message as if it came from `source`. */
    inject: (source: string, data: readonly number[]) => port?.send(source, data),
  }
}

export type MidiPerformance = ReturnType<typeof useMidiPerformance>
