import type { EffectType, InstrumentId } from './types'
import type { NativePluginDescriptor } from '../audio/native/contracts'
import { isInstrumentId } from './instruments'
import { EFFECT_TYPES } from './devices'
import { sigimsaeVariant } from './sigimsaeVariants'

/** One item from the right-side library: a sound source, an effect, or a project audio file. */
export type LibraryItem =
  | { kind: 'instrument'; instrument: InstrumentId }
  /** `variantId` picks a library variant (src/core/sigimsaeVariants.ts) of the module. */
  | { kind: 'effect'; effectType: EffectType; variantId?: string }
  | { kind: 'plugin'; plugin: NativePluginDescriptor }
  | { kind: 'asset'; assetId: string }

/** What a drop target cares about; VST3 plugins land in the instrument or effect role. */
export type LibraryRole = 'instrument' | 'effect' | 'audio'

export const LIBRARY_MIME = 'application/x-garak-library'
const ROLE_MIME = (role: LibraryRole) => `application/x-garak-library-${role}`

export function libraryRole(item: LibraryItem): LibraryRole {
  if (item.kind === 'plugin') return item.plugin.isInstrument ? 'instrument' : 'effect'
  return item.kind === 'asset' ? 'audio' : item.kind
}

export function writeLibraryDrag(data: DataTransfer, item: LibraryItem): void {
  data.setData(LIBRARY_MIME, JSON.stringify(item))
  // Only types are readable during dragover, so the role travels as its own (empty) type.
  data.setData(ROLE_MIME(libraryRole(item)), '')
  data.effectAllowed = 'copy'
}

/** The dragged library role, readable in dragover; null for anything that is not a library item. */
export function draggedLibraryRole(data: DataTransfer): LibraryRole | null {
  const types = Array.from(data.types)
  if (!types.includes(LIBRARY_MIME)) return null
  return (['instrument', 'effect', 'audio'] as const).find(role => types.includes(ROLE_MIME(role))) ?? null
}

export function parseLibraryItem(raw: string): LibraryItem | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case 'instrument': return isInstrumentId(v.instrument) ? { kind: 'instrument', instrument: v.instrument } : null
    case 'effect': {
      if (!EFFECT_TYPES.includes(v.effectType as EffectType)) return null
      const variant = typeof v.variantId === 'string' ? sigimsaeVariant(v.variantId) : undefined
      return variant && variant.effectType === v.effectType ? { kind: 'effect', effectType: variant.effectType, variantId: variant.id } : { kind: 'effect', effectType: v.effectType as EffectType }
    }
    case 'asset': return typeof v.assetId === 'string' && v.assetId ? { kind: 'asset', assetId: v.assetId } : null
    case 'plugin': {
      const p = v.plugin as Record<string, unknown> | undefined
      if (!p || typeof p.pluginId !== 'string' || typeof p.classId !== 'string' || typeof p.name !== 'string' || typeof p.isInstrument !== 'boolean') return null
      return { kind: 'plugin', plugin: { pluginId: p.pluginId, classId: p.classId, name: p.name, vendor: typeof p.vendor === 'string' ? p.vendor : '', isInstrument: p.isInstrument } }
    }
    default: return null
  }
}

export const readLibraryDrag = (data: DataTransfer): LibraryItem | null => parseLibraryItem(data.getData(LIBRARY_MIME))
