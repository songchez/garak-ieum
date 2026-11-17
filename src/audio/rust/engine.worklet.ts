import { GarakEngineError, instantiateGarakEngine, LIVE_EVENT, type EngineApplied, type GarakEngine, type LiveEventKind } from './garakEngineWasm.js'
import {
  ANALYSIS_FRAMES, AnalysisRings, AnalysisWriter, CommandRing, emptyStatus, ENGINE_PROCESSOR, MeterWriter, RING_LIVE, StatusWriter,
  type EngineMeters, type EngineProcessorOptions, type EngineReply, type EngineRequest, type RingCommand,
} from './engineChannel.js'
import { liveOffsetFrames } from './liveTiming.js'

declare const sampleRate: number
declare const currentFrame: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void

const TRANSPORT = ['play', 'pause', 'stop', 'seek', 'countIn'] as const
const LIVE_KINDS = Object.keys(LIVE_EVENT) as LiveEventKind[]
/** Without a SharedArrayBuffer, status and meters are posted every this many quanta (~37 ms at 48 kHz). */
const STATUS_EVERY = 14
/** Meters go to the shared block every this many quanta (~21 ms at 48 kHz). */
const METERS_EVERY = 8
/** Analysis taps are published every this many quanta (~32 ms at 48 kHz) while any is requested. */
const ANALYSIS_EVERY = 12
/** Retired graphs are freed this many quanta after the last edit (never inside the edit's quantum). */
const COLLECT_AFTER = 8
/** A staged update builds tracks after the render until this much of the quantum is used (fraction). */
const STAGE_BUDGET = 0.35
/** PCM uploads copy this many samples per quantum (2 MiB): a long file never stalls the audio thread. */
const ASSET_CHUNK = 1 << 19

/**
 * The unified Rust render engine (garak-engine.wasm) as one AudioWorklet node: the whole project —
 * clips, effect chains, sends/returns, automation, master, metronome — renders here, the same code the
 * native engine runs (docs/RUST_ENGINE.md 5). Control messages run in order between render quanta; a
 * project.set/patch is staged (parsed and classified at once, then one track built per quantum after the
 * render, committed when all are built), so a large project never stalls the audio thread. Input 0 is
 * the live input monitored tracks hear; output 0 the mix, output 1 the route recording taps.
 */
class GarakEngineProcessor extends AudioWorkletProcessor {
  private engine: GarakEngine | null = null
  private readonly ring: CommandRing | null
  private readonly writer: StatusWriter | null
  private readonly meters: MeterWriter | null
  private readonly analysisWriter: AnalysisWriter | null
  private readonly analysisRings = new AnalysisRings()
  private analysisCount = 0
  private sinceAnalysis = 0
  private readonly clock: () => number
  private readonly status = emptyStatus()
  private readonly queue: EngineRequest[] = []
  private stage: { seq: number } | null = null
  private upload: { seq: number; id: string; sampleRate: number; channels: number; samples: Float32Array; buffer: number; offset: number } | null = null
  private appliedSeq = 0
  private pendingPeak = 0
  private sinceStatus = 0
  private sinceMeters = 0
  private collectIn = -1
  private alive = true
  private monitoring = false
  private tapCount = 0
  /** A control message ran since the last quantum (edits are timed apart from steady playback). */
  private controlled = false
  private readonly maxBlock: number

  constructor(options?: unknown) {
    super(options)
    const init = (options as { processorOptions?: EngineProcessorOptions & { clock?: SharedArrayBuffer } } | undefined)?.processorOptions
    this.maxBlock = Math.max(128, init?.maxBlock ?? 128)
    this.ring = init?.shared ? new CommandRing(init.shared.ring) : null
    this.writer = init?.shared ? new StatusWriter(init.shared.status) : null
    this.meters = init?.shared ? new MeterWriter(init.shared.meters) : null
    this.analysisWriter = init?.shared?.analysis ? new AnalysisWriter(init.shared.analysis) : null
    // AudioWorkletGlobalScope has no `performance` in Chrome. A benchmark passes a clock a worker keeps
    // current (microseconds); otherwise Date.now() (1 ms steps) still averages out over many quanta.
    const shared = init?.clock ? new Float64Array(init.clock) : null
    this.clock = shared ? () => shared[0] : typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now()
    try {
      if (!init || !(init.module instanceof WebAssembly.Module)) throw new Error('garak-engine.wasm was not passed to the worklet')
      this.engine = instantiateGarakEngine(init.module, sampleRate, this.maxBlock, false)
    } catch (error) {
      this.post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    }
    this.port.onmessage = event => { this.queue.push(event.data as EngineRequest); this.controlled = true; this.pump() }
  }

  private post(reply: EngineReply): void { this.port.postMessage(reply) }

  private ack(seq: number, applied?: EngineApplied): void {
    this.post({ type: 'ack', seq, applied, latency: this.engine?.latencyFrames ?? 0, tail: this.engine?.tailSeconds ?? 0 })
  }

  private refuse(seq: number, error: unknown): void {
    this.post({ type: 'error', seq, message: error instanceof Error ? error.message : String(error), engine: error instanceof GarakEngineError })
  }

  /** Runs queued messages in order until one starts a staged update. */
  private pump(): void {
    while (!this.stage && !this.upload && this.queue.length) {
      const message = this.queue.shift()!
      const engine = this.engine
      if (!engine) { this.post({ type: 'error', seq: message.seq, message: 'garak-engine.wasm is not running', engine: false }); this.appliedSeq = Math.max(this.appliedSeq, message.seq); continue }
      try {
        switch (message.type) {
          case 'asset':
            // One copy into the module, in pieces after the render when long; the transferred buffer is
            // dropped with this message.
            if (message.samples.length > ASSET_CHUNK) {
              this.upload = { seq: message.seq, id: message.id, sampleRate: message.sampleRate, channels: message.channels, samples: message.samples, buffer: engine.beginAsset(message.samples.length), offset: 0 }
              return
            }
            engine.putAsset(message.id, message.sampleRate, message.channels, message.samples)
            break
          case 'remove-asset': engine.removeAsset(message.id); this.collectIn = COLLECT_AFTER; break
          case 'samples': engine.registerSamples(message.json); break
          case 'set': case 'patch': {
            const todo = engine.stage(message.json, message.binary ?? undefined, message.type === 'patch')
            if (todo > 0) { this.stage = { seq: message.seq }; this.status.staging = todo; return }
            this.collectIn = COLLECT_AFTER
            this.ack(message.seq, engine.commit())
            this.appliedSeq = Math.max(this.appliedSeq, message.seq)
            continue
          }
          case 'transport': this.transport(message.command, message.frame); break
          case 'live': this.live(message.track, message.kind, message.pitch, message.value, message.id, message.at); break
          case 'kernels': for (const kernel of message.kernels) engine.importKernel(kernel); break
          case 'metronome': engine.setMetronome(message.on, message.gain, message.strokes ? [message.strokes[0], message.strokes[1], message.strokes[2]] : undefined); break
          case 'monitor': engine.monitor(message.tracks); this.monitoring = message.tracks.length > 0; break
          case 'taps': engine.taps(message.tracks); this.tapCount = message.tracks.length; break
          case 'analysis':
            engine.analysis(message.taps)
            this.analysisCount = Math.min(message.taps.length, engine.maxAnalysis)
            this.analysisRings.clear()
            this.sinceAnalysis = ANALYSIS_EVERY
            break
          case 'dispose':
            engine.destroy()
            this.engine = null
            this.alive = false
            break
        }
        this.ack(message.seq)
      } catch (error) {
        this.refuse(message.seq, error)
      }
      this.appliedSeq = Math.max(this.appliedSeq, message.seq)
    }
  }

  /** One part of a staged update after the render; commits when every track is built. */
  private advanceStage(began: number, quantumMs: number): void {
    const engine = this.engine, stage = this.stage
    if (!engine || !stage) return
    try {
      let done = false
      // At least one track per quantum; more while the quantum has room.
      do {
        done = engine.step()
        this.status.staging = Math.max(0, this.status.staging - 1)
      } while (!done && this.clock() - began < quantumMs * STAGE_BUDGET)
      if (!done) return
      const applied = engine.commit()
      this.collectIn = COLLECT_AFTER
      this.ack(stage.seq, applied)
    } catch (error) {
      this.refuse(stage.seq, error)
    }
    this.status.staging = 0
    this.appliedSeq = Math.max(this.appliedSeq, stage.seq)
    this.stage = null
    this.pump()
  }

  /** One piece of a long PCM upload after the render; hands the buffer over when it is full. */
  private advanceUpload(): void {
    const engine = this.engine, upload = this.upload
    if (!engine || !upload) return
    try {
      const end = Math.min(upload.samples.length, upload.offset + ASSET_CHUNK)
      engine.writeAsset(upload.buffer, upload.offset, upload.samples.subarray(upload.offset, end))
      upload.offset = end
      if (end < upload.samples.length) return
      engine.finishAsset(upload.id, upload.sampleRate, upload.channels, upload.buffer, upload.samples.length)
      this.ack(upload.seq)
    } catch (error) {
      this.refuse(upload.seq, error)
    }
    this.appliedSeq = Math.max(this.appliedSeq, upload.seq)
    this.upload = null
    this.pump()
  }

  private transport(command: number, frame: number): void {
    const name = TRANSPORT[command]
    if (name) this.engine?.transport(name, frame)
  }

  /** `at`: the context frame to sound at (0: this quantum's first frame); the engine starts it on that sample. */
  private live(track: number, kind: number, pitch: number, value: number, id: number, at: number): void {
    const name = LIVE_KINDS[kind]
    if (name) this.engine?.live(track, name, pitch, value, id, liveOffsetFrames(at, currentFrame))
  }

  private readonly applyRing = (command: RingCommand): void => {
    try {
      if (command.command === RING_LIVE) this.live(command.a ?? 0, command.b ?? 0, command.c ?? 0, command.d ?? 0, command.frame, command.e ?? 0)
      else this.transport(command.command, command.frame)
    } catch { /* A full engine queue: the next command retries. */ }
    this.appliedSeq = Math.max(this.appliedSeq, command.seq)
  }

  private takeMeters(engine: GarakEngine): EngineMeters {
    const { values, count } = engine.peaks()
    const meters = { revision: engine.revision, peaks: values.slice(0, count), dynamics: engine.takeDynamics() }
    engine.clearPeaks()
    return meters
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const engine = this.engine
    const out = outputs[0]
    if (!engine || !out?.length) return this.alive
    const began = this.clock()
    // Steady playback: the transport plays and no update is being built or applied around this quantum.
    const steady = engine.playing && !engine.countingIn && !this.stage && !this.upload && !this.controlled
    this.controlled = false
    this.ring?.drain(this.appliedSeq, this.applyRing)
    const frames = out[0].length
    // The live input only matters while a track is monitored.
    const live = this.monitoring ? inputs[0] ?? [] : []
    const channels = Math.min(live.length, engine.maxInputChannels)
    const taps = this.tapCount ? outputs[1] : undefined
    // A render quantum larger than the engine block (renderSizeHint) renders in pieces.
    for (let at = 0; at < frames;) {
      const n = Math.min(this.maxBlock, frames - at)
      if (channels) {
        const view = engine.inputView()
        for (let c = 0; c < channels; c += 1) {
          const source = live[c]
          for (let i = 0; i < n; i += 1) view[i * channels + c] = source[at + i]
        }
      }
      const [left, right] = engine.renderPlanarInput(n, channels)
      if (!left.length) break
      out[0].set(left, at)
      out[1]?.set(right, at)
      if (taps) {
        const view = engine.tapView(), slot = this.maxBlock * 2
        for (let k = 0; k < this.tapCount && 2 * k + 1 < taps.length; k += 1) {
          const l = taps[2 * k], r = taps[2 * k + 1]
          for (let i = 0; i < left.length; i += 1) { l[at + i] = view[k * slot + 2 * i]; r[at + i] = view[k * slot + 2 * i + 1] }
        }
      }
      if (this.analysisCount) this.analysisRings.append(engine.analysisView(), this.maxBlock, this.analysisCount, left.length)
      at += left.length
    }
    const s = this.status
    const quantumMs = frames / sampleRate * 1000
    if (this.upload) this.advanceUpload()
    else if (this.stage) this.advanceStage(began, quantumMs)
    this.pendingPeak = Math.max(this.pendingPeak, engine.masterPeak)
    if (this.collectIn >= 0 && this.collectIn-- === 0) engine.collect()
    s.frame = engine.frame
    s.playing = engine.playing
    s.countingIn = engine.countingIn
    s.contextFrame = currentFrame + frames
    s.revision = engine.revision
    s.appliedSeq = this.appliedSeq
    s.latency = engine.latencyFrames
    const counts = engine.liveCounts
    s.livePlayed = counts.played
    s.liveIgnored = counts.ignored
    if (this.writer) {
      if (this.meters && ++this.sinceMeters >= METERS_EVERY) {
        this.sinceMeters = 0
        const m = this.takeMeters(engine)
        this.meters.write(m.revision, m.peaks, m.peaks.length, m.dynamics)
      }
    }
    if (this.analysisCount && ++this.sinceAnalysis >= ANALYSIS_EVERY) {
      this.sinceAnalysis = 0
      if (this.analysisWriter) this.analysisWriter.write(this.analysisRings, this.analysisCount)
      else {
        const slots = Array.from({ length: this.analysisCount }, (_, k) => { const out = new Float32Array(ANALYSIS_FRAMES * 2); this.analysisRings.copySlot(k, out); return out })
        this.port.postMessage({ type: 'analysis', slots } satisfies EngineReply, slots.map(slot => slot.buffer))
      }
    }
    // Everything this quantum did on the audio thread: drain, render, staged build, meters, analysis.
    const elapsed = this.clock() - began
    s.quanta += 1
    s.renderMs += elapsed
    if (elapsed > s.renderMaxMs) s.renderMaxMs = elapsed
    if (elapsed > quantumMs) s.budgetMisses += 1
    if (steady) {
      s.playingQuanta += 1
      s.playingMs += elapsed
      if (elapsed > s.playingMaxMs) s.playingMaxMs = elapsed
      if (elapsed > quantumMs) s.playingMisses += 1
    }
    if (this.writer) {
      s.peak = this.pendingPeak
      this.pendingPeak = 0
      this.writer.write(s)
    } else if (++this.sinceStatus >= STATUS_EVERY) {
      this.sinceStatus = 0
      s.peak = this.pendingPeak
      this.pendingPeak = 0
      this.post({ type: 'status', status: { ...s }, meters: this.takeMeters(engine) })
    }
    return this.alive
  }
}

registerProcessor(ENGINE_PROCESSOR, GarakEngineProcessor)
