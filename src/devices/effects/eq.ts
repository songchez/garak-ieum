import type { EffectDef, ParamDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, noTail } from './shared.js'

const eqBand = (id: string, label: string): ParamDef => ({ id, label, min: -18, max: 18, default: 0, unit: 'db' })

const definition: EffectDef = {
  name: '3밴드 EQ', short: 'EQ',
  params: [eqBand('low', '저음'), eqBand('mid', '중음'), { id: 'midFreq', label: '중음 주파수', min: 200, max: 5000, default: 1000, unit: 'hz', scale: 'log' }, eqBand('high', '고음')],
}

export const eqEffect: RealtimeEffectModule = {
  id: 'eq', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const low = remember(context.createBiquadFilter())
    const mid = remember(context.createBiquadFilter())
    const high = remember(context.createBiquadFilter())
    low.type = 'lowshelf'
    low.frequency.value = 220
    mid.type = 'peaking'
    mid.Q.value = 0.9
    high.type = 'highshelf'
    high.frequency.value = 4500
    low.connect(mid).connect(high)
    return {
      input: low,
      output: high,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        setParameter(low.gain, clamp(p('low'), -40, 40), now, smooth)
        setParameter(mid.frequency, clamp(p('midFreq'), 20, context.sampleRate * 0.45), now, smooth)
        setParameter(mid.gain, clamp(p('mid'), -40, 40), now, smooth)
        setParameter(high.gain, clamp(p('high'), -40, 40), now, smooth)
      },
    }
  },
  tailSeconds: noTail,
}
