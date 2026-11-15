/** Standard MIDI Files (SMF) 0/1, with quarter-note beat positions.
 * Format reference: https://midi.org/standard-midi-files
 * Controller reference: https://midi.org/midi-1-0-control-change-messages
 * Parsing never starts audio, creates IDs, or changes the current project.
 */
import { controllerSpec, normalizeController, pruneController, ccKey, MAX_BEND_RANGE, DEFAULT_BEND_RANGE } from './controllers'
import type { ControllerKey } from './types'

export const MAX_MIDI_FILE_BYTES = 16 * 1024 * 1024
const MAX_TRACKS = 256
const MAX_EVENTS = 500_000
const MAX_NOTES = 100_000
const MAX_LENGTH_BEATS = 24_000

export interface MidiImportNote {
  pitch: number
  start: number
  duration: number
  velocity: number
}
export interface MidiImportTrack {
  name: string
  /** CC64 sustain pedal of this part's port/channel, in beats (absent when the file has none or it was baked). */
  sustain?: { beat: number; value: number }[]
  /** Zero-based MIDI channel; channel 9 is the General MIDI percussion channel. */
  channel: number
  /** Zero-based program at this track/channel's first note, when specified. */
  program?: number
  /**
   * Controller lanes of this part's port/channel in beats (docs/MIDI_CONTROLLERS.md): CCs other than the pedal,
   * channel-mode and RPN/NRPN messages, pitch bend, channel aftertouch, and program changes after the first note.
   */
  controllers?: Partial<Record<ControllerKey, { beat: number; value: number }[]>>
  /** Pitch-bend range in semitones from RPN 0 (absent = the default 2). */
  bendRange?: number
  notes: MidiImportNote[]
}
export interface MidiImportResult {
  tracks: MidiImportTrack[]
  lengthBeats: number
  /** Initial SMF tempo; defaults to 120 when no tempo is set at tick zero. */
  bpm?: number
  /** Initial SMF meter; defaults to 4/4 when no meter is set at tick zero. */
  timeSignature?: { numerator: number; denominator: number }
  warnings: string[]
}

export interface MidiImportOptions {
  /** Legacy "서스테인을 음 길이로 변환": lengthen notes through the pedal instead of keeping CC64 events. */
  sustainToLength?: boolean
}

function invalid(detail: string): never {
  throw new Error(`MIDI 파일을 읽을 수 없습니다: ${detail}`)
}

class Reader {
  position: number
  constructor(readonly bytes: Uint8Array, start = 0, readonly end = bytes.length) { this.position = start }
  get remaining(): number { return this.end - this.position }
  need(count: number): void {
    if (count < 0 || count > this.remaining) invalid('데이터가 잘렸거나 청크 길이가 잘못되었습니다.')
  }
  byte(): number { this.need(1); return this.bytes[this.position++] }
  dataByte(): number {
    const value = this.byte()
    if (value > 127) invalid('MIDI 이벤트의 데이터 바이트가 잘못되었습니다.')
    return value
  }
  word(): number { return this.byte() * 256 + this.byte() }
  dword(): number { return this.word() * 65536 + this.word() }
  id(): string { return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte()) }
  skip(count: number): void { this.need(count); this.position += count }
  take(count: number): Uint8Array {
    this.need(count)
    const value = this.bytes.subarray(this.position, this.position + count)
    this.position += count
    return value
  }
  variable(): number {
    let value = 0
    for (let i = 0; i < 4; ++i) {
      const byte = this.byte()
      value = value * 128 + (byte & 127)
      if (!(byte & 128)) return value
    }
    invalid('가변 길이 숫자는 최대 4바이트여야 합니다.')
  }
}

interface SourceTrack { name: string; endTick: number }
interface ChannelEvent {
  tick: number
  order: number
  track: number
  port: number
  channel: number
  type: number
  first: number
  second: number
}
interface TempoEvent { tick: number; order: number; microseconds: number }
interface MeterEvent { tick: number; order: number; numerator: number; denominator: number }
interface OutputTrack extends MidiImportTrack { source: number; port: number }
interface ActiveNote { track: OutputTrack; pitch: number; startTick: number; velocity: number }
interface NoteQueue { notes: ActiveNote[]; next: number }
interface ChannelState {
  program?: number
  sustain: boolean
  /** Kept CC64 events (tick, value) when the pedal is not baked into note lengths. */
  pedal: { tick: number; value: number }[]
  /** Controller lane events (tick, value) by key. */
  lanes: Map<ControllerKey, { tick: number; value: number }[]>
  /** Selected RPN (MSB*128+LSB; 0x3fff = none) and NRPN flag, for CC6 data entry. */
  rpn: number
  nrpn: boolean
  bendRange?: number
  /** Program changes in order (the first chooses the instrument, later ones become the program lane). */
  programs: { tick: number; value: number }[]
  held: Map<number, NoteQueue>
  sustained: Set<ActiveNote>
}

/** Last value per tick wins; repeated on/off states are dropped; a leading pedal-up is meaningless. */
function pedalEvents(events: readonly { tick: number; value: number }[], division: number): { beat: number; value: number }[] {
  const byTick: { tick: number; value: number }[] = []
  for (const event of events) {
    const last = byTick[byTick.length - 1]
    if (last && last.tick === event.tick) last.value = event.value
    else byTick.push({ ...event })
  }
  const result: { beat: number; value: number }[] = []
  let down = false
  for (const event of byTick) {
    const next = event.value >= 64
    if (next === down) continue
    result.push({ beat: event.tick / division, value: event.value })
    down = next
  }
  return result
}

/** Lane events in beats: last value per tick, repeats dropped, reset lanes holding only their default omitted.
 * Program changes up to the first note pick the instrument (MidiImportTrack.program); later ones form the lane. */
function laneEvents(state: ChannelState, division: number, firstNoteTick: number): NonNullable<MidiImportTrack['controllers']> {
  const result: NonNullable<MidiImportTrack['controllers']> = {}
  const lanes = new Map(state.lanes)
  const laterPrograms = state.programs.filter(event => event.tick > firstNoteTick)
  if (laterPrograms.length) lanes.set('program', [...state.programs.filter(event => event.tick <= firstNoteTick).slice(-1), ...laterPrograms])
  for (const [key, events] of lanes) {
    const points = pruneController(normalizeController(key, events.map(event => ({ beat: event.tick / division, value: event.value }))))
    const spec = controllerSpec(key)
    if (points.length && (!spec.reset || points.some(point => point.value !== spec.default))) result[key] = points
  }
  return result
}

function trackName(data: Uint8Array, warn: (message: string) => void): string {
  // Track labels cannot force an unbounded string allocation. The complete
  // meta payload is still skipped according to its declared byte length.
  const text = data.subarray(0, 1024)
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(text) }
  catch {
    decoded = new TextDecoder('windows-1252').decode(text)
    warn('UTF-8이 아닌 트랙 이름은 일부 문자가 다르게 표시될 수 있습니다.')
  }
  return decoded.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
}

/** Read a bounded SMF into editable notes. Tempo maps and expressive automation
 * are explicitly reported, rather than silently changing musical beat positions.
 * Simultaneous events keep file track/event order. Same-pitch note-offs match
 * the oldest held note, because MIDI 1.0 carries no per-note identity.
 */
export function parseMidiFile(data: ArrayBuffer | Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const bakeSustain = options.sustainToLength === true
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) invalid('올바른 파일 데이터가 아닙니다.')
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength > MAX_MIDI_FILE_BYTES) invalid('MIDI 파일은 16 MiB 이하로 나누어 가져와 주세요.')
  const file = new Reader(bytes)
  if (file.id() !== 'MThd') invalid('표준 MIDI(SMF) 파일이 아닙니다. .mid 또는 .midi 형식으로 다시 저장해 주세요.')
  const headerLength = file.dword()
  if (headerLength < 6) invalid('MIDI 헤더가 너무 짧습니다.')
  file.need(headerLength)
  const format = file.word(), trackCount = file.word(), division = file.word()
  file.skip(headerLength - 6)
  if (format === 2) invalid('독립 패턴 형식(Type 2)은 지원하지 않습니다. Type 0 또는 Type 1 MIDI로 다시 저장해 주세요.')
  if (format !== 0 && format !== 1) invalid('지원하지 않는 MIDI 형식입니다. Type 0 또는 Type 1 MIDI로 다시 저장해 주세요.')
  if (division & 0x8000) invalid('시간 기반(SMPTE) MIDI는 지원하지 않습니다. 박자 기반(PPQ) MIDI로 다시 저장해 주세요.')
  if (!division) invalid('박자 해상도(PPQ)는 0보다 커야 합니다.')
  if (!trackCount || trackCount > MAX_TRACKS || (format === 0 && trackCount !== 1)) invalid('트랙 수가 잘못되었거나 256개를 초과합니다.')

  const warnings = new Set<string>()
  const warn = (message: string): void => { warnings.add(message) }
  const sourceTracks: SourceTrack[] = []
  const events: ChannelEvent[] = []
  const tempos: TempoEvent[] = [], meters: MeterEvent[] = []
  let eventCount = 0, noteCount = 0, endTick = 0
  const maximumTick = MAX_LENGTH_BEATS * division

  while (file.remaining) {
    const id = file.id(), length = file.dword()
    file.need(length)
    if (id !== 'MTrk') {
      if (id === 'MThd') invalid('MIDI 헤더가 중복되어 있습니다.')
      // SMF readers must skip unknown chunk types, including future extensions.
      file.skip(length)
      continue
    }
    if (sourceTracks.length >= trackCount) invalid('헤더에 적힌 수보다 많은 MIDI 트랙이 들어 있습니다.')
    const track = sourceTracks.length
    const reader = new Reader(bytes, file.position, file.position + length)
    file.skip(length)
    const source: SourceTrack = { name: '', endTick: 0 }
    sourceTracks.push(source)
    let tick = 0, running = 0, port = 0, ended = false
    while (reader.remaining) {
      if (++eventCount > MAX_EVENTS) invalid('이벤트가 500,000개를 초과합니다. MIDI 파일을 나누어 가져와 주세요.')
      tick += reader.variable()
      if (tick > maximumTick) invalid('MIDI 길이가 24,000박을 초과합니다. 구간을 나누어 가져와 주세요.')
      const order = eventCount
      let status = reader.byte()
      let firstData: number | undefined
      if (status < 0x80) {
        if (!running) invalid('이전 상태가 없는 running status 이벤트입니다.')
        firstData = status
        status = running
      }
      if (status >= 0x80 && status <= 0xef) {
        running = status
        const type = status & 0xf0, channel = status & 15
        const first = firstData ?? reader.dataByte()
        const second = type === 0xc0 || type === 0xd0 ? 0 : reader.dataByte()
        if (type === 0x90 && second > 0 && ++noteCount > MAX_NOTES) invalid('노트가 100,000개를 초과합니다. MIDI 파일을 나누어 가져와 주세요.')
        if (type === 0xa0) { warn('키별 애프터터치(Poly Pressure)는 가져오지 않았습니다. 채널 애프터터치는 가져왔습니다.'); continue }
        events.push({ tick, order, track, port, channel, type, first, second })
        if (type === 0xb0 && first >= 124) warn('MIDI 채널 모드 변경은 노트 종료만 반영하고, 모든 노트를 개별 편집 노트로 가져왔습니다.')
        continue
      }

      // Unlike the wire protocol's realtime messages, SMF meta/SysEx events
      // explicitly cancel the previous channel-message running status.
      running = 0
      if (status === 0xf0 || status === 0xf7) {
        reader.skip(reader.variable())
        warn('SysEx 장치 설정과 전용 음색 데이터는 가져오지 않았습니다.')
        continue
      }
      if (status !== 0xff) invalid(`지원하지 않는 MIDI 파일 이벤트(0x${status.toString(16)})입니다.`)
      const type = reader.dataByte(), payload = reader.take(reader.variable())
      if (type === 0x2f) {
        if (payload.length !== 0 || reader.remaining !== 0) invalid('트랙 종료(End of Track) 이벤트의 길이나 위치가 잘못되었습니다.')
        ended = true
        break
      }
      if (type === 0x03) {
        if (!source.name) source.name = trackName(payload, warn)
      } else if (type === 0x51) {
        if (payload.length < 3) invalid('템포 메타데이터가 잘렸습니다.')
        const microseconds = payload[0] * 65536 + payload[1] * 256 + payload[2]
        if (!microseconds) invalid('템포 값은 0보다 커야 합니다.')
        tempos.push({ tick, order, microseconds })
      } else if (type === 0x58) {
        if (payload.length < 4 || !payload[0] || !payload[3]) invalid('박자표 메타데이터가 잘못되었습니다.')
        meters.push({ tick, order, numerator: payload[0], denominator: 2 ** payload[1] })
        if (payload[3] !== 8) warn('특수 박자 표기 정보는 가져오지 않았으며, 노트 위치는 MIDI 4분음표 기준으로 유지했습니다.')
      } else if (type === 0x21) {
        if (!payload.length || payload[0] > 127) invalid('MIDI 포트 메타데이터가 잘못되었습니다.')
        port = payload[0]
      } else if (type === 0x20) {
        if (!payload.length || payload[0] > 15) invalid('MIDI 채널 메타데이터가 잘못되었습니다.')
      } else if (type === 0x54) warn('SMPTE 시작 위치는 가져오지 않았습니다. 노트는 파일의 박자 위치에 배치됩니다.')
      else if (type === 0x05 || type === 0x06 || type === 0x07 || type === 0x59) warn('가사·마커·큐·키 조표 메타데이터는 가져오지 않았습니다.')
    }
    if (!ended) invalid('트랙 종료(End of Track) 이벤트가 없거나 파일이 잘렸습니다.')
    source.endTick = tick
    endTick = Math.max(endTick, tick)
  }
  if (sourceTracks.length !== trackCount) invalid('헤더에 적힌 MIDI 트랙이 파일에 모두 들어 있지 않습니다.')

  // Shared channel state is evaluated in musical order, even when sustain or
  // program changes live in a separate SMF track from the notes they affect.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const channels = new Map<number, ChannelState>()
  const outputs = new Map<string, OutputTrack>()
  const channelState = (port: number, channel: number): ChannelState => {
    const key = port * 16 + channel
    let state = channels.get(key)
    if (!state) { state = { sustain: false, pedal: [], lanes: new Map(), rpn: 0x3fff, nrpn: false, programs: [], held: new Map(), sustained: new Set() }; channels.set(key, state) }
    return state
  }
  const finish = (note: ActiveNote, tick: number): void => {
    if (tick === note.startTick) warn('같은 시점에 시작·종료된 노트는 1틱 길이로 가져왔습니다.')
    const last = Math.max(note.startTick + 1, tick)
    if (last > maximumTick) invalid('노트 끝이 가져올 수 있는 최대 MIDI 길이를 초과합니다.')
    note.track.notes.push({ pitch: note.pitch, start: note.startTick / division, duration: (last - note.startTick) / division, velocity: note.velocity })
    endTick = Math.max(endTick, last)
  }
  const release = (state: ChannelState, note: ActiveNote, tick: number): void => {
    if (state.sustain) state.sustained.add(note)
    else finish(note, tick)
  }
  const releaseSustain = (state: ChannelState, tick: number): void => {
    for (const note of state.sustained) finish(note, tick)
    state.sustained.clear()
  }
  for (const event of events) {
    const state = channelState(event.port, event.channel)
    const lane = (key: ControllerKey, value: number): void => {
      const list = state.lanes.get(key)
      if (list) list.push({ tick: event.tick, value })
      else state.lanes.set(key, [{ tick: event.tick, value }])
    }
    if (event.type === 0xc0) { state.program = event.first; state.programs.push({ tick: event.tick, value: event.first }); continue }
    if (event.type === 0xe0) { lane('pitchBend', event.second * 128 + event.first - 8192); continue }
    if (event.type === 0xd0) { lane('aftertouch', event.first); continue }
    if (event.type === 0xb0 && event.first < 120 && event.first !== 64) {
      // RPN/NRPN selection and data entry configure the instrument; only RPN 0 (pitch-bend range) is kept.
      if (event.first === 101 || event.first === 100) {
        state.nrpn = false
        state.rpn = event.first === 101 ? event.second * 128 + (state.rpn % 128) : state.rpn - (state.rpn % 128) + event.second
        continue
      }
      if (event.first === 99 || event.first === 98) { state.nrpn = true; warn('NRPN 장치 설정은 가져오지 않았습니다.'); continue }
      if (event.first === 6 || event.first === 38 || event.first === 96 || event.first === 97) {
        if (!state.nrpn && state.rpn === 0 && event.first === 6) state.bendRange = Math.min(MAX_BEND_RANGE, event.second)
        else if (!state.nrpn && state.rpn !== 0 && state.rpn !== 0x3fff) warn('피치 벤드 범위를 제외한 RPN 설정(미세 조율 등)은 가져오지 않았습니다.')
        continue
      }
      lane(ccKey(event.first), event.second)
      continue
    }
    if (event.type === 0xb0) {
      if (event.first === 121) {
        // Reset All Controllers: every reset lane returns to its default.
        for (const key of state.lanes.keys()) if (controllerSpec(key).reset) lane(key, controllerSpec(key).default)
      }
      if (event.first === 64) {
        if (!bakeSustain) { state.pedal.push({ tick: event.tick, value: event.second }); continue }
        state.sustain = event.second >= 64
        if (!state.sustain) releaseSustain(state, event.tick)
      } else if (event.first === 121) {
        // Reset All Controllers lifts the pedal.
        if (!bakeSustain) { state.pedal.push({ tick: event.tick, value: 0 }); continue }
        state.sustain = false
        releaseSustain(state, event.tick)
      } else {
        const immediate = event.first === 120
        for (const queue of state.held.values()) for (let i = queue.next; i < queue.notes.length; ++i) {
          if (immediate) finish(queue.notes[i], event.tick)
          else release(state, queue.notes[i], event.tick)
        }
        state.held.clear()
        if (immediate) releaseSustain(state, event.tick)
      }
      continue
    }
    if (event.type === 0x90 && event.second > 0) {
      const key = `${event.track}:${event.port}:${event.channel}`
      let track = outputs.get(key)
      if (!track) {
        if (outputs.size >= MAX_TRACKS) invalid('채널별로 나눈 노트 트랙이 256개를 초과합니다. 파일을 나누어 가져와 주세요.')
        track = { name: '', source: event.track, port: event.port, channel: event.channel, notes: [], ...(state.program === undefined ? {} : { program: state.program }) }
        outputs.set(key, track)
      }
      let queue = state.held.get(event.first)
      if (!queue) { queue = { notes: [], next: 0 }; state.held.set(event.first, queue) }
      queue.notes.push({ track, pitch: event.first, startTick: event.tick, velocity: event.second / 127 })
    } else {
      const queue = state.held.get(event.first)
      if (!queue) { warn('짝이 없는 노트 종료(Note Off) 이벤트는 건너뛰었습니다.'); continue }
      release(state, queue.notes[queue.next++], event.tick)
      if (queue.next === queue.notes.length) state.held.delete(event.first)
    }
  }
  // Incomplete notes stay recoverable, but may not extend a malformed file
  // forever. Use their owning track's declared end and disclose the repair.
  for (const state of channels.values()) {
    for (const queue of state.held.values()) for (let i = queue.next; i < queue.notes.length; ++i) {
      const note = queue.notes[i]
      finish(note, sourceTracks[note.track.source].endTick)
      warn('종료(Note Off)가 없는 노트는 해당 트랙의 끝에서 마무리했습니다.')
    }
    for (const note of state.sustained) {
      finish(note, sourceTracks[note.track.source].endTick)
      warn('파일 끝까지 유지된 서스테인 페달은 해당 트랙의 끝에서 해제했습니다.')
    }
  }

  let microseconds = 500_000, initialMicroseconds = microseconds
  tempos.sort((a, b) => a.tick - b.tick || a.order - b.order)
  for (const tempo of tempos) {
    if (tempo.tick === 0) initialMicroseconds = tempo.microseconds
    else if (tempo.microseconds !== microseconds) warn('곡 중간의 템포 변경은 가져오지 않았습니다. 노트 위치는 박자 기준으로 유지했습니다.')
    microseconds = tempo.microseconds
  }
  let currentMeter = { numerator: 4, denominator: 4 }, initialMeter = currentMeter
  meters.sort((a, b) => a.tick - b.tick || a.order - b.order)
  for (const meter of meters) {
    const next = { numerator: meter.numerator, denominator: meter.denominator }
    if (meter.tick === 0) initialMeter = next
    else if (next.numerator !== currentMeter.numerator || next.denominator !== currentMeter.denominator) warn('곡 중간의 박자표 변경은 가져오지 않았습니다. 처음 박자표와 원래 노트 위치를 유지했습니다.')
    currentMeter = next
  }
  const sorted = [...outputs.values()].sort((a, b) => a.source - b.source || a.port - b.port || a.channel - b.channel)
  const counts = new Map<number, number>(), ports = new Map<number, Set<number>>()
  for (const track of sorted) {
    counts.set(track.source, (counts.get(track.source) ?? 0) + 1)
    if (!ports.has(track.source)) ports.set(track.source, new Set())
    ports.get(track.source)!.add(track.port)
  }
  const tracks: MidiImportTrack[] = sorted.map(({ source, port, channel, program, notes }) => {
    const state = channels.get(port * 16 + channel)
    const sustain = pedalEvents(state?.pedal ?? [], division)
    const firstNoteTick = notes.reduce((first, note) => Math.min(first, Math.round(note.start * division)), Infinity)
    const lanes = state ? laneEvents(state, division, Number.isFinite(firstNoteTick) ? firstNoteTick : 0) : {}
    const bendRange = state?.bendRange !== undefined && state.bendRange !== DEFAULT_BEND_RANGE ? state.bendRange : undefined
    const base = sourceTracks[source].name || `MIDI 트랙 ${source + 1}`
    const name = `${base}${ports.get(source)!.size > 1 ? ` · Port ${port + 1}` : ''}${counts.get(source)! > 1 ? ` · Ch ${channel + 1}` : ''}`
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.duration - b.duration)
    return { name, channel, notes, ...(program === undefined ? {} : { program }), ...(sustain.length ? { sustain } : {}),
      ...(Object.keys(lanes).length ? { controllers: lanes } : {}), ...(bendRange === undefined ? {} : { bendRange }) }
  })
  return { tracks, lengthBeats: endTick / division, bpm: 60_000_000 / initialMicroseconds, timeSignature: initialMeter, warnings: [...warnings] }
}
