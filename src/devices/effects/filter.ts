import type { EffectDef, EffectModule } from '../contracts.js'
import { noTail } from './shared.js'
import { FILTER_SLOPES } from './eqModel.js'

const definition: EffectDef = {
  name: 'Sweep', short: '필터', label: '필터',
  params: [
    { id: 'cutoff', label: '컷오프', min: 20, max: 20000, default: 1200, unit: 'hz', scale: 'log' },
    { id: 'resonance', label: '레조넌스', min: 0.1, max: 18, default: 0.7, unit: 'q', scale: 'log' },
    { id: 'mode', label: '모드', min: 0, max: 2, default: 0, unit: 'q', options: [{ value: 0, label: '로우패스' }, { value: 1, label: '하이패스' }, { value: 2, label: '밴드패스' }] },
    // Appended after the original three; 12 dB/oct is the original single-stage filter.
    { id: 'slope', label: '기울기', min: 0, max: 2, default: 0, unit: 'q', options: FILTER_SLOPES.map((slope, value) => ({ value, label: `${slope} dB/oct` })) },
  ],
}

export const filterEffect: EffectModule = { id: 'filter', stateVersion: 1, definition, tailSeconds: noTail }
