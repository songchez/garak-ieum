import type { EffectDef, EffectModule } from '../contracts.js'
import { noTail } from './shared.js'
import { eqParamDefs } from './eqModel.js'

const definition: EffectDef = { name: 'Curve 8', short: 'EQ', label: '파라메트릭 EQ', params: eqParamDefs() }

export const eqEffect: EffectModule = { id: 'eq', stateVersion: 1, definition, tailSeconds: noTail }
