import type { EffectDef, EffectModule } from '../contracts.js'
import { noTail } from './shared.js'

const definition: EffectDef = {
  name: 'Hot Tube', short: '드라이브', label: '드라이브',
  params: [
    { id: 'drive', label: '드라이브', min: 0, max: 36, default: 9, unit: 'db' },
    { id: 'tone', label: '톤', min: 500, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
    { id: 'output', label: '출력', min: -24, max: 6, default: 0, unit: 'db' },
  ],
}

export const driveEffect: EffectModule = { id: 'drive', stateVersion: 1, definition, tailSeconds: noTail }
