import { describe, expect, it } from 'vitest'
import { LIBRARY_MIME, draggedLibraryRole, libraryRole, parseLibraryItem, readLibraryDrag, writeLibraryDrag, type LibraryItem } from './libraryDrag'

/** A minimal DataTransfer: jsdom-free, enough for set/get/types. */
function transfer() {
  const store = new Map<string, string>()
  return {
    effectAllowed: 'all',
    get types() { return [...store.keys()] },
    setData(type: string, value: string) { store.set(type, value) },
    getData(type: string) { return store.get(type) ?? '' },
  } as unknown as DataTransfer
}

const plugin = (isInstrument: boolean): LibraryItem => ({ kind: 'plugin', plugin: { pluginId: 'p', classId: 'abc', name: 'Plug', vendor: 'V', isInstrument } })

describe('library drag payloads', () => {
  it('round-trips each kind and exposes its role during dragover', () => {
    const items: LibraryItem[] = [{ kind: 'instrument', instrument: 'keys' }, { kind: 'effect', effectType: 'reverb' }, { kind: 'asset', assetId: 'a1' }, plugin(true), plugin(false)]
    for (const item of items) {
      const data = transfer()
      writeLibraryDrag(data, item)
      expect(readLibraryDrag(data)).toEqual(item)
      expect(draggedLibraryRole(data)).toBe(libraryRole(item))
      expect(data.effectAllowed).toBe('copy')
    }
  })
  it('maps VST3 plugins onto the instrument or effect role', () => {
    expect(libraryRole(plugin(true))).toBe('instrument')
    expect(libraryRole(plugin(false))).toBe('effect')
  })
  it('ignores foreign drags and malformed payloads', () => {
    const data = transfer()
    data.setData('Files', '')
    expect(draggedLibraryRole(data)).toBeNull()
    expect(parseLibraryItem('nope')).toBeNull()
    expect(parseLibraryItem(JSON.stringify({ kind: 'instrument', instrument: 'not-a-patch' }))).toBeNull()
    expect(parseLibraryItem(JSON.stringify({ kind: 'effect', effectType: 'wah' }))).toBeNull()
    expect(parseLibraryItem(JSON.stringify({ kind: 'plugin', plugin: { pluginId: 1 } }))).toBeNull()
    // A variant of another module falls back to the plain module; an unknown variant is dropped.
    expect(parseLibraryItem(JSON.stringify({ kind: 'effect', effectType: 'reverb', variantId: 'delay-slap' }))).toEqual({ kind: 'effect', effectType: 'reverb' })
    expect(parseLibraryItem(JSON.stringify({ kind: 'effect', effectType: 'delay', variantId: 'delay-slap' }))).toEqual({ kind: 'effect', effectType: 'delay', variantId: 'delay-slap' })
    expect(LIBRARY_MIME).toMatch(/^application\//)
  })
})
