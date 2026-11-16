import type { ControllerKey } from '../../core/types'
import type { DeviceGraph } from '../contracts'
import { VINTAGE_EVENT } from '../../audio/rust/vintageWasm'
import { loadVintageWasm, vintageWasmModule } from './availability'
import { EventQueue, type TimedEvent, type VintageMessage } from './queue'
import { VINTAGE_KIND, vintageParamVector, type VintageInstrumentId } from './params'

/**
 * Browser side of the vintage instruments: one AudioWorkletNode (the Rust core from garak-dsp.wasm)
 * per track input and instrument, created on the first note. Notes become timed events, so a voice
 * here is a handle that can move or cancel its note-off, like the Web Audio voices it stands in for.
 *
 * Realtime contexts post events as they are scheduled (the scheduler looks ahead). An offline render
 * gathers every event first and builds its nodes with them in `processorOptions` (`flushVintage`),
 * so nothing depends on when port messages reach the rendering thread.
 */

/** What graph.ts needs to file a voice like its own (ownership for edits, stop on dispose). */
export interface VintageVoiceHost {
  readonly context: BaseAudioContext
  readonly resources: DeviceGraph[]
}
export interface VintageVoice { stop(at: number): void; release(at: number, seconds: number): void; disconnect(): void }
export type AdoptVoice = (base: { stop(at: number): void; release(at: number, seconds: number): void; dispose(): void }) => VintageVoice

const prepared = new WeakMap<BaseAudioContext, Promise<boolean>>()
const ready = new WeakSet<BaseAudioContext>()
const isOffline = (context: BaseAudioContext) => typeof OfflineAudioContext !== 'undefined' && context instanceof OfflineAudioContext

/** Loads the module and registers the worklet on `context` once. Resolves false (never throws) when unavailable. */
export function prepareVintage(context: BaseAudioContext): Promise<boolean> {
  const existing = prepared.get(context)
  if (existing) return existing
  const task = (async () => {
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false
    const module = await loadVintageWasm()
    if (!module) return false
    const { default: url } = await import('./worklet-url.js')
    await context.audioWorklet.addModule(url)
    ready.add(context)
    return true
  })().catch(() => false)
  prepared.set(context, task)
  return task
}

export const vintageReady = (context: BaseAudioContext): boolean => ready.has(context)

class VintageNode {
  private node: AudioWorkletNode | null = null
  private pending: EventQueue | null = null
  private params: number[]
  private paramsKey: string
  private nextId = 1
  private disposed = false

  constructor(private readonly context: BaseAudioContext, private readonly destination: AudioNode, private readonly instrument: VintageInstrumentId,
    params: Readonly<Record<string, number>> | undefined) {
    this.params = vintageParamVector(instrument, params)
    this.paramsKey = this.params.join(',')
    if (isOffline(context)) this.pending = new EventQueue()
    else this.materialize()
  }

  /** Builds the worklet node (offline: with every gathered event). */
  materialize(): void {
    if (this.node || this.disposed) return
    const events = this.pending?.all() ?? []
    this.pending = null
    this.node = new AudioWorkletNode(this.context, 'garak-vintage', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { module: vintageWasmModule(), kind: VINTAGE_KIND[this.instrument], params: this.params, events },
    })
    this.node.connect(this.destination)
  }

  private post(message: VintageMessage): void {
    if (this.disposed) return
    if (this.node) { this.node.port.postMessage(message); return }
    const queue = this.pending
    if (!queue) return
    if (message.type === 'events') for (const event of message.events) queue.push(event)
    else if (message.type === 'off') queue.off(message.id, message.at)
    else if (message.type === 'params') {
      const at = message.at ?? 0
      message.values.forEach((value, param) => queue.push({ at, kind: VINTAGE_EVENT.param, id: -1, pitch: 0, value, param }))
    }
  }

  /** New parameter values from `at` (or now); unchanged values are not re-sent. */
  setParams(params: Readonly<Record<string, number>> | undefined, at?: number): void {
    const values = vintageParamVector(this.instrument, params)
    const key = values.join(',')
    if (key === this.paramsKey) return
    this.params = values
    this.paramsKey = key
    this.post({ type: 'params', values, ...(at !== undefined ? { at } : {}) })
  }

  note(pitch: number, when: number, duration: number, velocity: number): number {
    const id = this.nextId
    this.nextId = this.nextId >= 0x3fffffff ? 1 : this.nextId + 1
    const events: TimedEvent[] = [
      { at: when, kind: VINTAGE_EVENT.noteOn, id, pitch, value: Math.min(1, Math.max(0, velocity)), param: 0 },
      { at: when + duration, kind: VINTAGE_EVENT.noteOff, id, pitch, value: 0, param: 0 },
    ]
    this.post({ type: 'events', events })
    return id
  }

  off(id: number, at: number): void { this.post({ type: 'off', id, at }) }

  control(controller: number, value: number, at: number): void {
    this.post({ type: 'events', events: [{ at, kind: VINTAGE_EVENT.controller, id: -1, pitch: 0, value, param: controller }] })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.node) {
      this.node.port.postMessage({ type: 'dispose' } satisfies VintageMessage)
      try { this.node.disconnect() } catch { /* Already detached. */ }
    }
    this.pending = null
  }
}

/** Nodes by the track input they feed (the voice destination graph.ts passes) and instrument. */
const nodes = new WeakMap<AudioNode, Map<VintageInstrumentId, VintageNode>>()
const graphNodes = new WeakMap<VintageVoiceHost, VintageNode[]>()

function nodeFor(graph: VintageVoiceHost, destination: AudioNode, instrument: VintageInstrumentId, params: Readonly<Record<string, number>> | undefined): VintageNode | null {
  if (!ready.has(graph.context)) return null
  let byInstrument = nodes.get(destination)
  if (!byInstrument) nodes.set(destination, byInstrument = new Map())
  let node = byInstrument.get(instrument)
  if (!node) {
    try { node = new VintageNode(graph.context, destination, instrument, params) } catch { return null }
    const created = node
    byInstrument.set(instrument, created)
    let list = graphNodes.get(graph)
    if (!list) graphNodes.set(graph, list = [])
    list.push(created)
    graph.resources.push({ input: destination, output: destination, update() {}, dispose: () => { created.dispose(); byInstrument!.delete(instrument) } })
  }
  return node
}

/** A note on the vintage instrument feeding `destination`; undefined while the Rust core is unavailable. */
export function scheduleVintage(graph: VintageVoiceHost, destination: AudioNode, instrument: VintageInstrumentId, pitch: number, when: number,
  duration: number, velocity: number, params: Readonly<Record<string, number>> | undefined, adopt: AdoptVoice): VintageVoice | undefined {
  const node = nodeFor(graph, destination, instrument, params)
  if (!node) return undefined
  // Parameters as they are at this onset (instrument automation is read per note, like the other instruments).
  node.setParams(params, when)
  const id = node.note(pitch, when, duration, velocity)
  let ended = false
  let cleanup: ReturnType<typeof setTimeout> | null = null
  const end = (at: number) => {
    if (ended) return
    ended = true
    node.off(id, Math.max(graph.context.currentTime, at))
  }
  const voice = adopt({
    stop: at => end(at),
    release: at => end(at),
    dispose: () => { if (cleanup !== null) clearTimeout(cleanup); end(graph.context.currentTime) },
  })
  // Realtime: forget the handle once the note (and a generous release) is over.
  if (!isOffline(graph.context) && Number.isFinite(duration) && duration < 600) {
    cleanup = setTimeout(() => { ended = true; voice.disconnect() }, Math.max(0, when + duration - graph.context.currentTime + 12) * 1000)
  }
  return voice
}

/** Offline render: build every gathered node now, right before startRendering(). */
export function flushVintage(graph: VintageVoiceHost): void {
  for (const node of graphNodes.get(graph) ?? []) node.materialize()
}

/** Knob edits: every vintage node feeding `destination` takes the track's parameters now (they glide). */
export function updateVintageParams(destination: AudioNode, instrument: string, params: Readonly<Record<string, number>> | undefined): void {
  const node = nodes.get(destination)?.get(instrument as VintageInstrumentId)
  node?.setParams(params)
}

/** Pitch bend, mod wheel and pressure for the vintage nodes feeding `destination` (CC7 / CC11 stay on the track's gain node). */
export function forwardVintageControl(destination: AudioNode, key: ControllerKey, value: number, time: number, range: number): void {
  const byInstrument = nodes.get(destination)
  if (!byInstrument?.size) return
  const messages: [number, number][] = []
  if (key === 'pitchBend') messages.push([131, Math.min(48, Math.max(0, range)) / 48], [129, (value + 8192) / 16383])
  else if (key === 'cc1') messages.push([1, value / 127])
  else if (key === 'aftertouch') messages.push([128, value / 127])
  else return
  for (const node of byInstrument.values()) for (const [controller, normalized] of messages) node.control(controller, normalized, time)
}
