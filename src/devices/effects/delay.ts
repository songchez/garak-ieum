import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp, secondsPerBeat } from '../../audio/math.js'
import { parameterReader, setParameter } from './shared.js'

const definition: EffectDef = {
  name: '딜레이', short: '딜레이',
  params: [
    { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
    {
      id: 'time', label: '시간', min: 0.25, max: 2, default: 0.75, unit: 'x',
      options: [{ value: 0.25, label: '1/16' }, { value: 0.5, label: '1/8' }, { value: 0.75, label: '1/8.' }, { value: 1, label: '1/4' }, { value: 1.5, label: '1/4.' }, { value: 2, label: '1/2' }],
    },
    { id: 'feedback', label: '피드백', min: 0, max: 0.95, default: 0.32, unit: 'pct' },
    { id: 'tone', label: '톤', min: 500, max: 16000, default: 3800, unit: 'hz', scale: 'log' },
  ],
}

export const delayEffect: RealtimeEffectModule = {
  id: 'delay', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const input = remember(context.createGain())
    const output = remember(context.createGain())
    const delay = remember(context.createDelay(4))
    const wet = remember(context.createGain())
    const tone = remember(context.createBiquadFilter())
    const feedback = remember(context.createGain())
    tone.type = 'lowpass'
    input.connect(output)
    input.connect(delay).connect(wet).connect(output)
    delay.connect(tone).connect(feedback).connect(delay)
    return {
      input,
      output,
      update(params, bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        setParameter(delay.delayTime, clamp(p('time') * secondsPerBeat(bpm), 0, 3.9), now, smooth)
        setParameter(wet.gain, clamp(p('amount'), 0, 1) * 0.45, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(feedback.gain, clamp(p('feedback'), 0, 0.95), now, smooth)
      },
    }
  },
  tailSeconds(params, bpm) {
    const p = parameterReader(definition.params, params)
    if (p('amount') <= 0) return 0
    const feedback = clamp(p('feedback'), 0, 0.95)
    const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
    const delay = clamp(p('time') * secondsPerBeat(bpm), 0, 3.9)
    return Math.min(30, delay * (repeats + 1) + 0.85)
  },
}
