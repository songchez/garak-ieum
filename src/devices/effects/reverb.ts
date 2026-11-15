import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, randomGenerator } from './shared.js'

/**
 * Space types. Each has a short and a long decaying-noise impulse; Size blends them. The impulse
 * shapes are mirrored by native/src/dsp.cpp impulse(): keep seconds, seeds and formulas identical.
 * 0 홀: smooth (1-t)^3.6 · 1 룸: short, fast (1-t)^4.5 · 2 플레이트: pre-emphasised (bright, dense)
 * noise, (1-t)^2.4 · 3 스프링: dark noise through a 29.3 ms feedback comb (the "drip").
 */
export const REVERB_SPACES = [
  { short: { seconds: 1.7, seed: 9183 }, long: { seconds: 4.2, seed: 61427 } },
  { short: { seconds: 0.35, seed: 4421 }, long: { seconds: 1.2, seed: 7717 } },
  { short: { seconds: 1.1, seed: 3301 }, long: { seconds: 3.2, seed: 8803 } },
  { short: { seconds: 0.9, seed: 5153 }, long: { seconds: 2.6, seed: 6007 } },
] as const

/** Raw (un-normalised) impulse; ConvolverNode normalises it, native normalises identically. */
export function reverbImpulse(sampleRate: number, space: number, kind: 'short' | 'long'): Float32Array[] {
  const { seconds, seed } = REVERB_SPACES[space][kind]
  const length = Math.ceil(sampleRate * seconds)
  const random = randomGenerator(seed)
  const comb = Math.round(0.0293 * sampleRate)
  const channels = [new Float32Array(length), new Float32Array(length)]
  for (const values of channels) {
    let previous = 0, dark = 0
    for (let frame = 0; frame < length; frame += 1) {
      const noise = random() * 2 - 1, t = frame / length
      if (space === 0) values[frame] = noise * Math.pow(1 - t, 3.6)
      else if (space === 1) values[frame] = noise * Math.pow(1 - t, 4.5)
      else if (space === 2) values[frame] = (noise - 0.65 * previous) * Math.pow(1 - t, 2.4)
      else {
        dark += 0.45 * (noise - dark)
        values[frame] = dark * Math.pow(1 - t, 3) + (frame >= comb ? 0.55 * values[frame - comb] : 0)
      }
      previous = noise
    }
  }
  return channels
}

const impulseBuffers = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()

function impulseBuffer(context: BaseAudioContext, space: number, kind: 'short' | 'long'): AudioBuffer {
  let cache = impulseBuffers.get(context)
  if (!cache) {
    cache = new Map()
    impulseBuffers.set(context, cache)
  }
  const key = `${space}:${kind}`
  const existing = cache.get(key)
  if (existing) return existing
  const data = reverbImpulse(context.sampleRate, space, kind)
  const buffer = context.createBuffer(2, data[0].length, context.sampleRate)
  for (let channel = 0; channel < 2; channel += 1) buffer.getChannelData(channel).set(data[channel])
  cache.set(key, buffer)
  return buffer
}

const definition: EffectDef = {
  name: '대청 Hall', short: '리버브', label: '리버브',
  params: [
    { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
    { id: 'size', label: '크기', min: 0, max: 1, default: 0.35, unit: 'pct' },
    { id: 'tone', label: '톤', min: 1000, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
    { id: 'type', label: '공간', min: 0, max: 3, default: 0, unit: 'x', options: [{ value: 0, label: '홀' }, { value: 1, label: '룸' }, { value: 2, label: '플레이트' }, { value: 3, label: '스프링' }] },
    { id: 'predelay', label: '프리딜레이', min: 0, max: 250, default: 0, unit: 'ms' },
    { id: 'lowcut', label: '로우컷', min: 20, max: 1000, default: 20, unit: 'hz', scale: 'log' },
    // Dry (original) level: 1 keeps the insert behaviour; 0 = 100% wet for return tracks (docs/SENDS_RETURNS.md).
    { id: 'dry', label: '원음', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

const spaceOf = (value: number) => clamp(Math.round(value), 0, REVERB_SPACES.length - 1)

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
    const dry = remember(context.createGain())
    const predelay = remember(context.createDelay(0.3))
    const lowcut = remember(context.createBiquadFilter())
    let space = 0
    small.buffer = impulseBuffer(context, space, 'short')
    large.buffer = impulseBuffer(context, space, 'long')
    tone.type = 'lowpass'
    lowcut.type = 'lowshelf'
    lowcut.Q.value = 0.5
    input.connect(dry).connect(output)
    input.connect(predelay)
    predelay.connect(small).connect(smallGain).connect(tone)
    predelay.connect(large).connect(largeGain).connect(tone)
    tone.connect(lowcut).connect(wet).connect(output)
    return {
      input,
      output,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        const nextSpace = spaceOf(p('type'))
        if (nextSpace !== space) {
          space = nextSpace
          small.buffer = impulseBuffer(context, space, 'short')
          large.buffer = impulseBuffer(context, space, 'long')
        }
        const size = clamp(p('size'), 0, 1)
        setParameter(smallGain.gain, 1 - size, now, smooth)
        setParameter(largeGain.gain, size, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(wet.gain, clamp(p('amount'), 0, 1) * 0.5, now, smooth)
        setParameter(dry.gain, clamp(p('dry'), 0, 1), now, smooth)
        setParameter(predelay.delayTime, clamp(p('predelay'), 0, 250) / 1000, now, smooth)
        // At 20 Hz the low cut is off: a 0 dB shelf is an exact pass-through (native skips the filter).
        const cut = clamp(p('lowcut'), 20, 1000)
        lowcut.type = cut > 20.5 ? 'highpass' : 'lowshelf'
        lowcut.gain.value = 0
        setParameter(lowcut.frequency, cut, now, smooth)
      },
    }
  },
  tailSeconds(params) {
    const p = parameterReader(definition.params, params)
    if (p('amount') <= 0) return 0
    const { short, long } = REVERB_SPACES[spaceOf(p('type'))]
    return 0.85 + short.seconds + clamp(p('size'), 0, 1) * (long.seconds - short.seconds) + p('predelay') / 1000
  },
}
