import type { DeviceGraph, RememberNode, RealtimeEffectModule } from '../contracts.js'
import { dbToGain, setParameter } from '../effects/shared.js'
import { guitarRigDefinition, GUITAR_RIG_PARAMS } from './definition.js'
import { ampVoicing, cabinetFilters, saturationCurve } from './voicing.js'

export * from './definition.js'
const prepared = new WeakMap<BaseAudioContext, Promise<void>>()
const ready = new WeakSet<BaseAudioContext>()
const processorErrors = new WeakMap<BaseAudioContext, Error>()
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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

function createRig(context: BaseAudioContext, remember: RememberNode): DeviceGraph & { dispose(): void } {
  const processors: AudioWorkletNode[] = []
  try { return buildRig(context, remember, processors) } catch (error) {
    // The host cannot call dispose on an effect that failed before returning a DeviceGraph.
    closeProcessors(processors)
    throw error
  }
}

function buildRig(context: BaseAudioContext, remember: RememberNode, processors: AudioWorkletNode[]): DeviceGraph & { dispose(): void } {
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
  const compressor = worklet('garak-guitar-compressor-v1')
  const chorus = worklet('garak-guitar-chorus-v1')
  const input = gain()
  const output = gain()
  input.connect(compressor)

  // Compressor → drive. Parallel dry bypass preserves signal instead of bypassing the whole rig.
  const driveDry = gain(1), driveSend = gain(0), drivePre = gain(), drivePost = gain()
  const driveShaper = remember(context.createWaveShaper())
  driveShaper.curve = saturationCurve('drive'); driveShaper.oversample = '2x'
  const driveInputFilter = filter('highpass', 95)
  const driveTone = filter('lowpass', 5000)
  const driveDc = filter('highpass', 25)
  const driveOut = gain()
  compressor.connect(driveDry).connect(driveOut)
  compressor.connect(driveSend).connect(driveInputFilter).connect(drivePre).connect(driveShaper).connect(driveTone).connect(driveDc).connect(drivePost).connect(driveOut)

  // Two simple saturating preamp stages with model-specific interstage shaping.
  const ampDry = gain(0), ampSend = gain(1), ampPre = gain(), ampInter = gain(), ampPost = gain()
  const ampInputFilter = filter('highpass', 45)
  const ampShaper = remember(context.createWaveShaper())
  const ampPowerShaper = remember(context.createWaveShaper())
  ampShaper.curve = saturationCurve('amp', 1)
  ampPowerShaper.curve = saturationCurve('amp', 1, 1)
  ampShaper.oversample = '2x'; ampPowerShaper.oversample = '2x'
  const ampInterFilter = filter('lowpass', 9500)
  const ampDc = filter('highpass', 25)
  const bass = filter('lowshelf', 150), mid = filter('peaking', 750, 0.8), treble = filter('highshelf', 2600), presence = filter('highshelf', 4200)
  const ampOut = gain()
  driveOut.connect(ampDry).connect(ampOut)
  driveOut.connect(ampSend).connect(ampInputFilter).connect(ampPre).connect(ampShaper).connect(ampInterFilter).connect(ampInter).connect(ampPowerShaper).connect(ampDc).connect(bass).connect(mid).connect(treble).connect(presence).connect(ampPost).connect(ampOut)

  // Seven minimum-phase IIR sections: no IR file, FFT partition or pre-delay is introduced.
  const cabDry = gain(0), cabSend = gain(1), cabOut = gain()
  const cabNodes = cabinetFilters(1, 0, 0.35, 0.15).map(setting => filter(setting.type, setting.frequency, setting.Q))
  ampOut.connect(cabDry).connect(cabOut)
  ampOut.connect(cabSend).connect(cabNodes[0])
  for (let i = 1; i < cabNodes.length; i += 1) cabNodes[i - 1].connect(cabNodes[i])
  cabNodes[cabNodes.length - 1].connect(cabOut)
  cabOut.connect(chorus)

  // Post-cabinet modulation/delay keeps ambience from being distorted by the amp.
  const delaySend = gain(0), delay = remember(context.createDelay(1.3)), delayWet = gain(0), feedback = gain(0)
  const delayLowpass = filter('lowpass', 4400, 0.5), delayHighpass = filter('highpass', 120, 0.5)
  chorus.connect(output)
  chorus.connect(delaySend).connect(delay).connect(delayLowpass).connect(delayHighpass).connect(delayWet).connect(output)
  delayHighpass.connect(feedback).connect(delay)
  let disposed = false

  const set = (parameter: AudioParam, value: number, now: number, smooth: boolean) => setParameter(parameter, value, now, smooth)
  const setWorklet = (node: AudioWorkletNode, name: string, value: number, now: number, smooth: boolean) => {
    const parameter = node.parameters.get(name)
    if (parameter) set(parameter, value, now, smooth)
  }
  const bypass = (dry: GainNode, send: GainNode, enabled: boolean, now: number, smooth: boolean) => {
    set(dry.gain, enabled ? 0 : 1, now, smooth)
    set(send.gain, enabled ? 1 : 0, now, smooth)
  }
  return {
    input, output,
    update(params, _bpm, now, smooth) {
      if (disposed) return
      const p = reader(params)
      setWorklet(compressor, 'sustain', p('compSustain'), now, smooth)
      setWorklet(compressor, 'attack', p('compAttack'), now, smooth)
      setWorklet(compressor, 'level', p('compLevel'), now, smooth)
      setWorklet(compressor, 'enabled', p('compEnabled') >= 0.5 ? 1 : 0, now, false)
      const driveEnabled = p('driveEnabled') >= 0.5
      bypass(driveDry, driveSend, driveEnabled, now, smooth)
      const driveGain = dbToGain(p('driveGain'))
      set(drivePre.gain, driveGain, now, smooth)
      set(drivePost.gain, dbToGain(p('driveLevel')) / Math.pow(driveGain, 0.4), now, smooth)
      set(driveTone.frequency, Math.min(context.sampleRate * 0.45, 1200 * Math.pow(8, p('driveTone'))), now, smooth)
      bypass(ampDry, ampSend, p('ampEnabled') >= 0.5, now, smooth)
      const model = Math.round(p('ampModel'))
      const voicing = ampVoicing(model)
      // Model changes use smoothed stage gain/filters; never swap a shaper curve mid-note.
      const ampGain = dbToGain(p('ampGain'))
      set(ampPre.gain, ampGain * voicing.preGain, now, smooth)
      set(ampInter.gain, voicing.interstageGain, now, smooth)
      set(ampInputFilter.frequency, voicing.preHighpass, now, smooth)
      set(ampInterFilter.frequency, Math.min(context.sampleRate * 0.45, voicing.interstageLowpass), now, smooth)
      set(ampPost.gain, dbToGain(p('ampLevel')) * voicing.compensation / Math.pow(ampGain, 0.15), now, smooth)
      for (const [node, key] of [[bass, 'ampBass'], [mid, 'ampMid'], [treble, 'ampTreble'], [presence, 'ampPresence']] as const) set(node.gain, p(key), now, smooth)
      bypass(cabDry, cabSend, p('cabinetEnabled') >= 0.5, now, smooth)
      const settings = cabinetFilters(p('cabinet'), p('micType'), p('micPosition'), p('micDistance'))
      settings.forEach((setting, i) => {
        set(cabNodes[i].frequency, Math.min(context.sampleRate * 0.45, setting.frequency), now, smooth)
        set(cabNodes[i].Q, setting.Q, now, smooth)
        set(cabNodes[i].gain, setting.gain, now, smooth)
      })
      setWorklet(chorus, 'rate', p('chorusRate'), now, smooth)
      setWorklet(chorus, 'depth', p('chorusDepth'), now, smooth)
      setWorklet(chorus, 'mix', p('chorusMix'), now, smooth)
      setWorklet(chorus, 'enabled', p('chorusEnabled') >= 0.5 ? 1 : 0, now, false)
      const delayEnabled = p('delayEnabled') >= 0.5
      set(delaySend.gain, delayEnabled ? 1 : 0, now, smooth)
      set(delay.delayTime, p('delayTime') / 1000, now, smooth)
      set(feedback.gain, delayEnabled ? p('delayFeedback') : 0, now, smooth)
      set(delayWet.gain, delayEnabled ? p('delayMix') : 0, now, smooth)
    },
    dispose() {
      if (disposed) return
      disposed = true
      closeProcessors(processors)
      feedback.gain.value = 0
      delaySend.gain.value = 0
    },
  }
}

export const guitarRigEffect: RealtimeEffectModule = {
  id: 'guitar-rig', kind: 'realtime-effect', stateVersion: 1, definition: guitarRigDefinition,
  prepare: prepareGuitarRig,
  create: createRig,
  tailSeconds(params) {
    const p = reader(params)
    const chorusTail = p('chorusEnabled') >= 0.5 && p('chorusMix') > 0 ? 0.04 : 0
    if (p('delayEnabled') < 0.5 || p('delayMix') <= 0) return chorusTail
    const feedback = p('delayFeedback')
    const repeats = feedback > 0.001 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
    return chorusTail + p('delayTime') / 1000 * (repeats + 1) + 0.2
  },
}
