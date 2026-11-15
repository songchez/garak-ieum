import type { EffectDevice } from './types'
import { EFFECT_DEFS } from './devices'
import { createDevice } from './project'
import type { SigimsaeVariant } from './sigimsaeVariants'

/** A new device for the variant; the default variant keeps the module name (no stored name). */
export function deviceFromVariant(variant: SigimsaeVariant): EffectDevice {
  const device = createDevice(variant.effectType, variant.params)
  return variant.id === variant.effectType ? device : { ...device, name: variant.name }
}

/** Header name of a builtin effect device. */
export const effectDeviceName = (device: Pick<EffectDevice, 'type' | 'name'>): string => device.name || EFFECT_DEFS[device.type].name
