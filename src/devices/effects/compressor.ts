import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, dbToGain, noTail } from './shared.js'

const definition: EffectDef = {
  name: '컴프레서', short: '컴프',
  params: [
    { id: 'threshold', label: '스레숄드', min: -60, max: 0, default: -18, unit: 'db' },
    { id: 'ratio', label: '비율', min: 1, max: 20, default: 4, unit: 'ratio', scale: 'log' },
    { id: 'attack', label: '어택', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' },
    { id: 'release', label: '릴리즈', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
    { id: 'makeup', label: '메이크업', min: 0, max: 24, default: 0, unit: 'db' },
  ],
}

export const compressorEffect: RealtimeEffectModule = {
  id: 'compressor', kind: 'realtime-effect', stateVersion: 1, definition,
  create(context, remember) {
    const compressor = remember(context.createDynamicsCompressor())
    const makeup = remember(context.createGain())
    compressor.knee.value = 6
    compressor.connect(makeup)
    return {
      input: compressor,
      output: makeup,
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        setParameter(compressor.threshold, clamp(p('threshold'), -100, 0), now, smooth)
        setParameter(compressor.ratio, clamp(p('ratio'), 1, 20), now, smooth)
        setParameter(compressor.attack, clamp(p('attack') / 1000, 0, 1), now, smooth)
        setParameter(compressor.release, clamp(p('release') / 1000, 0, 1), now, smooth)
        setParameter(makeup.gain, dbToGain(clamp(p('makeup'), -60, 40)), now, smooth)
      },
    }
  },
  tailSeconds: noTail,
}
