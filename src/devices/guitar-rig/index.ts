import type { DeviceGraph, RememberNode, RealtimeEffectModule } from '../contracts.js'
import { dbToGain, setParameter } from '../effects/shared.js'
import { guitarRigDefinition, guitarRigOrder, parseRigSlot, rigParam, GUITAR_RIG_PARAMS, type GuitarRigModuleId, type GuitarRigSlotKey } from './definition.js'
import { ampVoicing, cabinetFilters, saturationCurve } from './voicing.js'
import { REVERB_HIGHPASS_HZ, reverbImpulses, reverbTailSeconds, reverbToneHz } from './reverb.js'
import { registerGuitarTunerTap, unregisterGuitarTunerTap, type GuitarTunerTap } from './tuner.js'

export * from './definition.js'
export { detectPitch, guitarTunerTap, tunerReading, TUNER_A4, type TunerReading } from './tuner.js'

/** A live rig graph carries its tuner tap so the host can bind it to the device id. */
type RigGraph = DeviceGraph & { dispose(): void; tunerTap: GuitarTunerTap }

/** Lets the editor of `deviceId` read this rig's tuner. Offline (export) contexts are ignored. */
export function bindGuitarRigDevice(graph: DeviceGraph, deviceId: string, context: BaseAudioContext): void {
  const tap = (graph as Partial<RigGraph>).tunerTap
  if (!tap || 'startRendering' in context) return
  registerGuitarTunerTap(deviceId, tap)
}
const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()
const processorErrors = new WeakMap<BaseAudioContext, Error>()
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** Fuzz Tone knob → lowpass cutoff (500 Hz – 5 kHz). Keep in sync with native/src/dsp.cpp. */
const fuzzToneHz = (tone: number) => 500 * Math.pow(10, tone)

/** Await for each realtime AND offline context before synchronously building a rig. */
export function prepareGuitarRig(context: BaseAudioContext): Promise<void> {
  const existing = prepared.get(context)
  if (existing) return existing
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('기타 앰프의 오디오 프로세서를 사용할 수 없습니다. 지원되는 데스크톱 앱 또는 보안 연결에서 열어 주세요.'))
  // MCP/Node imports the catalog without evaluating a browser-only worker asset.
  // Vite emits this lazily loaded module and processor as same-origin JS, never blob:.
  const promise = import('./worklet-url.js')
    .then(({ default: processorsUrl }) => context.audioWorklet.addModule(processorsUrl))
    .then(() => { ready.add(context) }).catch(error => {
    prepared.delete(context)
    throw new Error(`기타 앰프 오디오 프로세서를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
  })
  prepared.set(context, promise)
  return promise
}

/** Call after offline rendering so a failed processor cannot silently export empty audio. */
export function assertGuitarRigHealthy(context: BaseAudioContext): void {
  const error = processorErrors.get(context)
  if (error) throw error
}

function createProcessor(context: BaseAudioContext, name: string): AudioWorkletNode {
  const node = new AudioWorkletNode(context, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  node.onprocessorerror = () => {
    processorErrors.set(context, new Error('기타 앰프 오디오 처리 중 오류가 발생했습니다. 오디오 설정을 다시 적용해 주세요.'))
    // The engine already watches context errors and stops playback/monitoring safely.
    context.dispatchEvent?.(new Event('error'))
  }
  return node
}

/** Same prepared module, no lookahead; used identically for monitoring and WAV export. */
export function createGuitarRigMaster(context: BaseAudioContext, remember: RememberNode): DeviceGraph {
  if (!ready.has(context)) throw new Error('기타 앰프 마스터를 만들기 전에 prepareGuitarRig(context)를 완료해야 합니다.')
  const node = createProcessor(context, 'garak-guitar-master-v1')
  try { remember(node) } catch (error) { closeProcessors([node]); throw error }
  let disposed = false
  return {
    input: node, output: node,
    update() {},
    dispose() { if (!disposed) { disposed = true; closeProcessors([node]) } },
  }
}

/** Compatibility name for hosts preloading all built-in audio modules. */
export const prepareGuitarRigWorklet = prepareGuitarRig

function reader(params: Record<string, number>): (id: string) => number {
  return id => {
    const def = GUITAR_RIG_PARAMS.find(p => p.id === id)!
    const value = params[id]
    return clamp(Number.isFinite(value) ? value : def.default, def.min, def.max)
  }
}

function closeProcessors(processors: readonly AudioWorkletNode[]): void {
  for (const processor of processors) {
    // A retired graph must not fault a newer graph sharing this context.
    processor.onprocessorerror = null
    try { processor.port.postMessage({ type: 'dispose' }) } catch { /* Context may have closed. */ }
    processor.port.close()
  }
}

function createRig(context: BaseAudioContext, remember: RememberNode): RigGraph {
  const processors: AudioWorkletNode[] = []
  try { return buildRig(context, remember, processors) } catch (error) {
    // The host cannot call dispose on an effect that failed before returning a DeviceGraph.
    closeProcessors(processors)
    throw error
  }
}

type Read = (base: string) => number
/** One copy of a rack module: its own nodes, wired in/out, updated from its own parameters. */
interface RigSegment { in: AudioNode; out: AudioNode; update(p: Read, now: number, smooth: boolean): void; dispose?(): void }

function buildRig(context: BaseAudioContext, remember: RememberNode, processors: AudioWorkletNode[]): RigGraph {
  if (!ready.has(context)) throw new Error('기타 앰프를 만들기 전에 prepareGuitarRig(context)를 완료해야 합니다.')
  const gain = (value = 1) => { const node = remember(context.createGain()); node.gain.value = value; return node }
  const filter = (type: BiquadFilterType, frequency: number, q = 0.707) => {
    const node = remember(context.createBiquadFilter())
    node.type = type; node.frequency.value = Math.min(context.sampleRate * 0.45, frequency); node.Q.value = q
    return node
  }
  const worklet = (name: string) => {
    const node = createProcessor(context, name)
    processors.push(node)
    return remember(node)
  }
  const nyquist = (hz: number) => Math.min(context.sampleRate * 0.45, hz)
  const set = (parameter: AudioParam, value: number, now: number, smooth: boolean) => setParameter(parameter, value, now, smooth)
  const setWorklet = (node: AudioWorkletNode, name: string, value: number, now: number, smooth: boolean) => {
    const parameter = node.parameters.get(name)
    if (parameter) set(parameter, value, now, smooth)
  }
  const bypass = (dry: GainNode, send: GainNode, enabled: boolean, now: number, smooth: boolean) => {
    set(dry.gain, enabled ? 0 : 1, now, smooth)
    set(send.gain, enabled ? 1 : 0, now, smooth)
  }
  /** Worklet pedals (compressor, chorus, phaser, tremolo) take their knobs as AudioParams by name. */
  const workletSegment = (name: string, prefix: string, knobs: readonly (readonly [string, string])[]): RigSegment => {
    const node = worklet(name), input = gain(), output = gain()
    input.connect(node).connect(output)
    return { in: input, out: output, update(p, now, smooth) {
      for (const [param, key] of knobs) setWorklet(node, param, p(key), now, smooth)
      setWorklet(node, 'enabled', p(`${prefix}Enabled`) >= 0.5 ? 1 : 0, now, false)
    } }
  }
  /** Drive and fuzz: a parallel dry path keeps the signal when the pedal is bypassed. */
  const clipperSegment = (kind: 'drive' | 'fuzz'): RigSegment => {
    const dry = gain(1), send = gain(0), pre = gain(), post = gain()
    const shaper = remember(context.createWaveShaper())
    shaper.curve = saturationCurve(kind); shaper.oversample = '2x'
    const inputFilter = kind === 'drive' ? filter('highpass', 95) : filter('highpass', 40)
    const tone = kind === 'drive' ? filter('lowpass', 5000) : filter('lowpass', 1500)
    const dc = filter('highpass', 25)
    const input = gain(), output = gain()
    input.connect(dry).connect(output)
    input.connect(send).connect(inputFilter).connect(pre).connect(shaper).connect(tone).connect(dc).connect(post).connect(output)
    return { in: input, out: output, update(p, now, smooth) {
      bypass(dry, send, p(`${kind}Enabled`) >= 0.5, now, smooth)
      if (kind === 'drive') {
        const driveGain = dbToGain(p('driveGain'))
        set(pre.gain, driveGain, now, smooth)
        set(post.gain, dbToGain(p('driveLevel')) / Math.pow(driveGain, 0.4), now, smooth)
        set(tone.frequency, nyquist(1200 * Math.pow(8, p('driveTone'))), now, smooth)
      } else {
        set(pre.gain, dbToGain(p('fuzzGain')), now, smooth)
        set(post.gain, dbToGain(p('fuzzLevel')), now, smooth)
        set(tone.frequency, nyquist(fuzzToneHz(p('fuzzTone'))), now, smooth)
      }
    } }
  }
  // Two simple saturating preamp stages with model-specific interstage shaping.
  const ampSegment = (): RigSegment => {
    const dry = gain(0), send = gain(1), pre = gain(), inter = gain(), post = gain()
    const inputFilter = filter('highpass', 45)
    const shaper = remember(context.createWaveShaper()), powerShaper = remember(context.createWaveShaper())
    shaper.curve = saturationCurve('amp', 1); powerShaper.curve = saturationCurve('amp', 1, 1)
    shaper.oversample = '2x'; powerShaper.oversample = '2x'
    const interFilter = filter('lowpass', 9500), dc = filter('highpass', 25)
    const bass = filter('lowshelf', 150), mid = filter('peaking', 750, 0.8), treble = filter('highshelf', 2600), presence = filter('highshelf', 4200)
    const input = gain(), output = gain()
    input.connect(dry).connect(output)
    input.connect(send).connect(inputFilter).connect(pre).connect(shaper).connect(interFilter).connect(inter).connect(powerShaper).connect(dc).connect(bass).connect(mid).connect(treble).connect(presence).connect(post).connect(output)
    return { in: input, out: output, update(p, now, smooth) {
      bypass(dry, send, p('ampEnabled') >= 0.5, now, smooth)
      const voicing = ampVoicing(Math.round(p('ampModel')))
      // Model changes use smoothed stage gain/filters; never swap a shaper curve mid-note.
      const ampGain = dbToGain(p('ampGain'))
      set(pre.gain, ampGain * voicing.preGain, now, smooth)
      set(inter.gain, voicing.interstageGain, now, smooth)
      set(inputFilter.frequency, voicing.preHighpass, now, smooth)
      set(interFilter.frequency, nyquist(voicing.interstageLowpass), now, smooth)
      set(post.gain, dbToGain(p('ampLevel')) * voicing.compensation / Math.pow(ampGain, 0.15), now, smooth)
      for (const [node, key] of [[bass, 'ampBass'], [mid, 'ampMid'], [treble, 'ampTreble'], [presence, 'ampPresence']] as const) set(node.gain, p(key), now, smooth)
    } }
  }
  // Seven minimum-phase IIR sections: no IR file, FFT partition or pre-delay is introduced.
  const cabinetSegment = (): RigSegment => {
    const input = gain(), dry = gain(0), send = gain(1), output = gain()
    const nodes = cabinetFilters(1, 0, 0.35, 0.15).map(setting => filter(setting.type, setting.frequency, setting.Q))
    input.connect(dry).connect(output)
    input.connect(send).connect(nodes[0])
    for (let i = 1; i < nodes.length; i += 1) nodes[i - 1].connect(nodes[i])
    nodes[nodes.length - 1].connect(output)
    return { in: input, out: output, update(p, now, smooth) {
      bypass(dry, send, p('cabinetEnabled') >= 0.5, now, smooth)
      cabinetFilters(p('cabinet'), p('micType'), p('micPosition'), p('micDistance')).forEach((setting, i) => {
        set(nodes[i].frequency, nyquist(setting.frequency), now, smooth)
        set(nodes[i].Q, setting.Q, now, smooth)
        set(nodes[i].gain, setting.gain, now, smooth)
      })
    } }
  }
  // Delay with filtered feedback; dry always passes.
  const delaySegment = (): RigSegment => {
    const send = gain(0), delay = remember(context.createDelay(1.3)), wet = gain(0), feedback = gain(0)
    const lowpass = filter('lowpass', 4400, 0.5), highpass = filter('highpass', 120, 0.5)
    const input = gain(), output = gain()
    input.connect(output)
    input.connect(send).connect(delay).connect(lowpass).connect(highpass).connect(wet).connect(output)
    highpass.connect(feedback).connect(delay)
    return { in: input, out: output, update(p, now, smooth) {
      const enabled = p('delayEnabled') >= 0.5
      set(send.gain, enabled ? 1 : 0, now, smooth)
      set(delay.delayTime, p('delayTime') / 1000, now, smooth)
      set(feedback.gain, enabled ? p('delayFeedback') : 0, now, smooth)
      set(wet.gain, enabled ? p('delayMix') : 0, now, smooth)
    }, dispose() { feedback.gain.value = 0; send.gain.value = 0 } }
  }
  // Plate-style reverb: dry always passes; the wet send feeds two convolvers (short and long IR)
  // whose gains crossfade with Decay. Buffers load on first audible use, so an unused reverb costs nothing.
  const reverbSegment = (): RigSegment => {
    const input = gain(), output = gain(), send = gain(0), wet = gain(0)
    const shortGain = gain(0.55), longGain = gain(0.45)
    const short = remember(context.createConvolver()), long = remember(context.createConvolver())
    short.normalize = false; long.normalize = false
    const highpass = filter('highpass', REVERB_HIGHPASS_HZ, 0.5), tone = filter('lowpass', reverbToneHz(0.5), 0.5)
    input.connect(output)
    input.connect(send).connect(highpass)
    highpass.connect(short).connect(shortGain).connect(tone)
    highpass.connect(long).connect(longGain).connect(tone)
    tone.connect(wet).connect(output)
    let loaded = false
    return { in: input, out: output, update(p, now, smooth) {
      const enabled = p('reverbEnabled') >= 0.5
      if (enabled && !loaded) {
        loaded = true
        const impulses = reverbImpulses(context.sampleRate)
        for (const [node, ir] of [[short, impulses.short], [long, impulses.long]] as const) {
          const buffer = context.createBuffer(2, ir[0].length, context.sampleRate)
          buffer.copyToChannel(ir[0], 0); buffer.copyToChannel(ir[1], 1)
          node.buffer = buffer
        }
      }
      set(send.gain, enabled ? 1 : 0, now, smooth)
      set(shortGain.gain, 1 - p('reverbDecay'), now, smooth)
      set(longGain.gain, p('reverbDecay'), now, smooth)
      set(tone.frequency, nyquist(reverbToneHz(p('reverbTone'))), now, smooth)
      set(wet.gain, enabled ? p('reverbMix') : 0, now, smooth)
    }, dispose() { send.gain.value = 0 } }
  }

  // Tuner: engaged = output muted, like a pedal tuner. The analyser always sees the signal arriving at
  // the tuner's rack position; its silent sink keeps it pulled by the graph in every browser.
  const tunerIn = gain(), tunerOut = gain(), tunerPass = gain(1), tunerSink = gain(0)
  const analyser = remember(context.createAnalyser())
  analyser.fftSize = context.sampleRate > 50000 ? 8192 : 4096
  tunerIn.connect(tunerPass).connect(tunerOut)
  tunerIn.connect(analyser).connect(tunerSink).connect(tunerOut)
  const tunerTap: GuitarTunerTap = { analyser, sampleRate: context.sampleRate }
  const tuner: RigSegment = { in: tunerIn, out: tunerOut, update(p, now, smooth) { set(tunerPass.gain, p('tunerEnabled') >= 0.5 ? 0 : 1, now, smooth) } }

  const factories: Record<GuitarRigModuleId, () => RigSegment> = {
    comp: () => workletSegment('garak-guitar-compressor-v1', 'comp', [['sustain', 'compSustain'], ['attack', 'compAttack'], ['level', 'compLevel']]),
    drive: () => clipperSegment('drive'), fuzz: () => clipperSegment('fuzz'), amp: ampSegment, cabinet: cabinetSegment,
    chorus: () => workletSegment('garak-guitar-chorus-v1', 'chorus', [['rate', 'chorusRate'], ['depth', 'chorusDepth'], ['mix', 'chorusMix']]),
    delay: delaySegment,
    phaser: () => workletSegment('garak-guitar-phaser-v1', 'phaser', [['rate', 'phaserRate'], ['depth', 'phaserDepth'], ['feedback', 'phaserFeedback']]),
    tremolo: () => workletSegment('garak-guitar-tremolo-v1', 'tremolo', [['rate', 'tremoloRate'], ['depth', 'tremoloDepth'], ['shape', 'tremoloShape']]),
    reverb: reverbSegment, tuner: () => tuner,
  }
  const input = gain()
  const output = gain()
  let disposed = false
  // Segments are built the first time their rack slot appears and kept (unwired) after removal, so
  // moving a pedal never rebuilds it. Every segment's out only ever feeds the next one.
  const segments = new Map<GuitarRigSlotKey, RigSegment>()
  let wiredOrder = ''
  const wire = (order: readonly GuitarRigSlotKey[]) => {
    const key = order.join(',')
    if (key === wiredOrder) return
    wiredOrder = key
    for (const slot of order) if (!segments.has(slot)) segments.set(slot, factories[parseRigSlot(slot).id]())
    input.disconnect()
    for (const item of segments.values()) item.out.disconnect()
    let previous: AudioNode = input
    for (const slot of order) { const item = segments.get(slot)!; previous.connect(item.in); previous = item.out }
    previous.connect(output)
  }
  wire(guitarRigOrder({}))

  return {
    input, output, tunerTap,
    update(params, _bpm, now, smooth) {
      if (disposed) return
      wire(guitarRigOrder(params))
      const p = reader(params)
      for (const [key, item] of segments) { const { instance } = parseRigSlot(key); item.update(base => p(rigParam(base, instance)), now, smooth) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unregisterGuitarTunerTap(tunerTap)
      closeProcessors(processors)
      for (const item of segments.values()) item.dispose?.()
    },
  }
}

export const guitarRigEffect: RealtimeEffectModule = {
  id: 'guitar-rig', kind: 'realtime-effect', stateVersion: 1, definition: guitarRigDefinition,
  prepare: prepareGuitarRig,
  create: createRig,
  tailSeconds(params) {
    const p = reader(params)
    let tail = 0
    for (const key of guitarRigOrder(params)) {
      const { id, instance } = parseRigSlot(key), q = (base: string) => p(rigParam(base, instance))
      if (id === 'chorus' && q('chorusEnabled') >= 0.5 && q('chorusMix') > 0) tail += 0.04
      if (id === 'reverb' && q('reverbEnabled') >= 0.5 && q('reverbMix') > 0) tail += reverbTailSeconds(q('reverbDecay'))
      if (id === 'delay' && q('delayEnabled') >= 0.5 && q('delayMix') > 0) {
        const feedback = q('delayFeedback')
        const repeats = feedback > 0.001 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
        tail += q('delayTime') / 1000 * (repeats + 1) + 0.2
      }
    }
    return tail
  },
}
