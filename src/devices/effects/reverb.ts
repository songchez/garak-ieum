import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, randomGenerator } from './shared.js'

const impulseBuffers = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()
const IMPULSES = {
  small: { seconds: 1.7, seed: 9183 },
  large: { seconds: 4.2, seed: 61427 },
}

function impulseBuffer(context: BaseAudioContext, kind: keyof typeof IMPULSES): AudioBuffer {
  let cache = impulseBuffers.get(context)
  if (!cache) {
    cache = new Map()
    impulseBuffers.set(context, cache)
  }
  const existing = cache.get(kind)
  if (existing) return existing
  const { seconds, seed } = IMPULSES[kind]
  const length = Math.ceil(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  const random = randomGenerator(seed)
  for (let channel = 0; channel < 2; channel += 1) {
    const values = buffer.getChannelData(channel)
    for (let frame = 0; frame < length; frame += 1) {
      values[frame] = (random() * 2 - 1) * Math.pow(1 - frame / length, 3.6)
    }
  }
  cache.set(kind, buffer)
  return buffer
}

const definition: EffectDef = {
  name: '리버브', short: '리버브',
  params: [
    { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
    { id: 'size', label: '크기', min: 0, max: 1, default: 0.35, unit: 'pct' },
    { id: 'tone', label: '톤', min: 1000, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
  ],
}

export const reverbEffect: RealtimeEffectModule = {
  id: 'reverb', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const input = remember(context.createGain())
    const output = remember(context.createGain())
    const small = remember(context.createConvolver())
    const large = remember(context.createConvolver())
    const smallGain = remember(context.createGain())
    const largeGain = remember(context.createGain())
    const tone = remember(context.createBiquadFilter())
    const wet = remember(context.createGain())
    small.buffer = impulseBuffer(context, 'small')
    large.buffer = impulseBuffer(context, 'large')
    tone.type = 'lowpass'
    input.connect(output)
    input.connect(small).connect(smallGain).connect(tone)
    input.connect(large).connect(largeGain).connect(tone)
    tone.connect(wet).connect(output)
    return {
      input,
      output,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        const size = clamp(p('size'), 0, 1)
        setParameter(smallGain.gain, 1 - size, now, smooth)
        setParameter(largeGain.gain, size, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(wet.gain, clamp(p('amount'), 0, 1) * 0.5, now, smooth)
      },
    }
  },
  tailSeconds(params) {
    const p = parameterReader(definition.params, params)
    return p('amount') > 0 ? 0.85 + 1.7 + clamp(p('size'), 0, 1) * 2.5 : 0
  },
}
