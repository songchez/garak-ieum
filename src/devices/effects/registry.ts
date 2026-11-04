import type { EffectType } from '../../core/types.js'
import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { eqEffect } from './eq.js'
import { filterEffect } from './filter.js'
import { compressorEffect } from './compressor.js'
import { driveEffect } from './drive.js'
import { delayEffect } from './delay.js'
import { reverbEffect } from './reverb.js'
import { guitarRigEffect } from '../guitar-rig/index.js'

/** Registration order is the existing rack/catalog order; no audio objects are created on import. */
export const EFFECT_MODULES = {
  eq: eqEffect,
  filter: filterEffect,
  compressor: compressorEffect,
  drive: driveEffect,
  delay: delayEffect,
  reverb: reverbEffect,
  'guitar-rig': guitarRigEffect,
} satisfies Record<EffectType, RealtimeEffectModule>

export const EFFECT_TYPES = Object.keys(EFFECT_MODULES) as EffectType[]
export const EFFECT_DEFS = Object.fromEntries(
  EFFECT_TYPES.map(id => [id, EFFECT_MODULES[id].definition]),
) as Record<EffectType, EffectDef>
