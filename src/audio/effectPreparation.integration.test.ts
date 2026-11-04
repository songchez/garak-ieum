import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareEffects } from './effectPreparation'

afterEach(() => { vi.unstubAllGlobals() })

describe('built-in worklet registration', () => {
  it('preloads the rig even before a project contains it, once for each context', async () => {
    // No audio nodes are needed to register a module. This is not a DSP test.
    vi.stubGlobal('AudioWorkletNode', class {})
    const liveLoad = vi.fn(async (_url: string | URL) => undefined)
    const offlineLoad = vi.fn(async (_url: string | URL) => undefined)
    const live = { audioWorklet: { addModule: liveLoad } } as unknown as BaseAudioContext
    const offline = { audioWorklet: { addModule: offlineLoad } } as unknown as BaseAudioContext
    await prepareEffects(live)
    await prepareEffects(live)
    await prepareEffects(offline)
    expect(liveLoad).toHaveBeenCalledTimes(1)
    expect(offlineLoad).toHaveBeenCalledTimes(1)
    const url = liveLoad.mock.calls[0][0] as string
    expect(url).not.toMatch(/^blob:|^data:/)
    expect(offlineLoad).toHaveBeenCalledWith(url)
  })

  it('fails explicitly when the built-in processor cannot load', async () => {
    vi.stubGlobal('AudioWorkletNode', class {})
    const context = { audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error('CSP refused processor')) } } as unknown as BaseAudioContext
    await expect(prepareEffects(context)).rejects.toThrow('CSP refused processor')
  })
})
