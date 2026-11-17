import type { EffectDef, EffectModule } from '../contracts.js'
import { noTail } from './shared.js'

const definition: EffectDef = {
  name: 'Glue 76', short: '컴프', label: '컴프레서',
  params: [
    { id: 'threshold', label: '스레숄드', min: -60, max: 0, default: -18, unit: 'db' },
    { id: 'ratio', label: '비율', min: 1, max: 20, default: 4, unit: 'ratio', scale: 'log' },
    { id: 'attack', label: '어택', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' },
    { id: 'release', label: '릴리즈', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
    { id: 'makeup', label: '메이크업', min: 0, max: 24, default: 0, unit: 'db' },
  ],
}

export const compressorEffect: EffectModule = { id: 'compressor', stateVersion: 1, definition, tailSeconds: noTail }
