import { describe, expect, it } from 'vitest'
import { defaultEditorPanel, editorPanelHeight, loadEditorPanel, PANEL_STORAGE_KEY, sanitizeEditorPanel, saveEditorPanel } from './editorPanel'

describe('editor workspace size', () => {
  it('keeps space for the arrangement, with a separate collapsed and maximized size', () => {
    expect(editorPanelHeight(420, 800)).toBe(420)
    expect(editorPanelHeight(900, 800)).toBe(640)
    expect(editorPanelHeight(40, 800)).toBe(180)
    expect(editorPanelHeight(420, 800, true)).toBe(40)
    expect(editorPanelHeight(420, 800, false, true)).toBe(800)
  })
  it('fits short viewports and restores the stored preferred size when space returns', () => {
    const preferred = 500
    expect(editorPanelHeight(preferred, 300)).toBe(140)
    expect(editorPanelHeight(preferred, 900)).toBe(500)
    expect(editorPanelHeight(preferred, 120)).toBe(40)
    expect(Number.isFinite(editorPanelHeight(NaN, Infinity))).toBe(true)
  })
  it('remembers a separate size for each editor and recovers from invalid storage', () => {
    const store = new Map<string, string>()
    const adapter = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    const state = defaultEditorPanel()
    state.heights.piano = 480
    state.heights.mixer = 260
    state.collapsed = true
    saveEditorPanel(state, adapter)
    expect(loadEditorPanel(adapter)).toEqual(state)
    store.set(PANEL_STORAGE_KEY, '{broken')
    expect(loadEditorPanel(adapter).collapsed).toBe(false)
    const cleaned = sanitizeEditorPanel({ heights: { piano: -1, mixer: 90000, pitch: NaN }, collapsed: 'yes' })
    expect(cleaned.heights.piano).toBe(180)
    expect(cleaned.heights.mixer).toBe(4000)
    expect(cleaned.collapsed).toBe(false)
    expect(() => saveEditorPanel(state, { getItem: () => null, setItem: () => { throw new Error('quota') } })).not.toThrow()
  })
})
