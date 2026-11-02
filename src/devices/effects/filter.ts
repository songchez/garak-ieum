import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, noTail } from './shared.js'

const FILTER_MODES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass']

const definition: EffectDef = {
  name: '필터', short: '필터',
  params: [
    { id: 'cutoff', label: '컷오프', min: 20, max: 20000, default: 1200, unit: 'hz', scale: 'log' },
    { id: 'resonance', label: '레조넌스', min: 0.1, max: 18, default: 0.7, unit: 'q', scale: 'log' },
    { id: 'mode', label: '모드', min: 0, max: 2, default: 0, unit: 'q', options: [{ value: 0, label: '로우패스' }, { value: 1, label: '하이패스' }, { value: 2, label: '밴드패스' }] },
  ],
}

export const filterEffect: RealtimeEffectModule = {
  id: 'filter', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const filter = remember(context.createBiquadFilter())
    return {
      input: filter,
      output: filter,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        const type = FILTER_MODES[clamp(Math.round(p('mode')), 0, FILTER_MODES.length - 1)]
        if (filter.type !== type) filter.type = type
        setParameter(filter.frequency, clamp(p('cutoff'), 10, context.sampleRate * 0.45), now, smooth)
        setParameter(filter.Q, clamp(p('resonance'), 0.0001, 40), now, smooth)
      },
    }
  },
  tailSeconds: noTail,
}
