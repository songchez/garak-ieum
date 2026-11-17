import type { EffectType } from '../../core/types.js'
import type { EffectDef, EffectModule } from '../contracts.js'
import { eqEffect } from './eq.js'
import { filterEffect } from './filter.js'
import { compressorEffect } from './compressor.js'
import { driveEffect } from './drive.js'
import { reverbEffect } from './reverb.js'
import { bitcrusherEffect, chorusEffect, delayEffect, flangerEffect, gateEffect, limiterEffect, phaserEffect, tapeEffect, tremoloEffect, utilityEffect } from './sigimsae.js'
import { guitarRigEffect } from '../guitar-rig/index.js'

/** Registration order is the saved/catalog order (new modules append); no audio objects are created on import. */
export const EFFECT_MODULES = {
  eq: eqEffect,
  filter: filterEffect,
  compressor: compressorEffect,
  drive: driveEffect,
  delay: delayEffect,
  reverb: reverbEffect,
  'guitar-rig': guitarRigEffect,
  chorus: chorusEffect,
  phaser: phaserEffect,
  flanger: flangerEffect,
  tremolo: tremoloEffect,
  limiter: limiterEffect,
  gate: gateEffect,
  tape: tapeEffect,
  bitcrusher: bitcrusherEffect,
  utility: utilityEffect,
} satisfies Record<EffectType, EffectModule>

export const EFFECT_TYPES = Object.keys(EFFECT_MODULES) as EffectType[]
export const EFFECT_DEFS = Object.fromEntries(
  EFFECT_TYPES.map(id => [id, EFFECT_MODULES[id].definition]),
) as Record<EffectType, EffectDef>

/** Plain type label for an effect ("리버브"), shown under its display name. */
export const effectLabel = (type: EffectType): string => EFFECT_DEFS[type].label ?? EFFECT_DEFS[type].short
