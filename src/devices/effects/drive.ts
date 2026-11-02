import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, dbToGain, noTail } from './shared.js'

let driveCurve: Float32Array<ArrayBuffer> | null = null

function shaperCurve(): Float32Array<ArrayBuffer> {
  if (driveCurve) return driveCurve
  const points = 2048
  driveCurve = new Float32Array(points)
  for (let point = 0; point < points; point += 1) {
    const x = point / (points - 1) * 2 - 1
    driveCurve[point] = Math.tanh(2.5 * x) / Math.tanh(2.5)
  }
  return driveCurve
}

const definition: EffectDef = {
  name: '드라이브', short: '드라이브',
  params: [
    { id: 'drive', label: '드라이브', min: 0, max: 36, default: 9, unit: 'db' },
    { id: 'tone', label: '톤', min: 500, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
    { id: 'output', label: '출력', min: -24, max: 6, default: 0, unit: 'db' },
  ],
}

export const driveEffect: RealtimeEffectModule = {
  id: 'drive', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const input = remember(context.createGain())
    const dry = remember(context.createGain())
    const pre = remember(context.createGain())
    const shaper = remember(context.createWaveShaper())
    const tone = remember(context.createBiquadFilter())
    const post = remember(context.createGain())
    const wet = remember(context.createGain())
    const output = remember(context.createGain())
    shaper.curve = shaperCurve()
    shaper.oversample = '2x'
    tone.type = 'lowpass'
    input.connect(dry).connect(output)
    input.connect(pre).connect(shaper).connect(tone).connect(post).connect(wet).connect(output)
    return {
      input,
      output,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        const mix = clamp(p('mix'), 0, 1)
        const outputGain = dbToGain(clamp(p('output'), -60, 24))
        const preGain = dbToGain(clamp(p('drive'), -24, 48))
        setParameter(dry.gain, (1 - mix) * outputGain, now, smooth)
        setParameter(pre.gain, preGain, now, smooth)
        setParameter(tone.frequency, clamp(p('tone'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(post.gain, outputGain / Math.sqrt(preGain * 2.53), now, smooth)
        setParameter(wet.gain, mix, now, smooth)
      },
    }
  },
  tailSeconds: noTail,
}
