import { describe, expect, it, vi } from 'vitest'
import { AssetPcmCache, assetMemory, createAudioAsset, overviewPeaks, pcmBytes, referencedAssetIds } from './assetPcm'
import { fakePcm } from './testAssets'
import { createEmptyProject, createTrack } from '../core/project'
import type { AudioClip } from '../core/types'
import { pyramidMax } from '../core/waveformPyramid'

const ramp = (frames: number, scale = 1) => Array.from({ length: frames }, (_, i) => Math.sin(i / 7) * scale)

/** A decoder that "decodes" the blob's first byte into a known PCM (like decodeAudioData, a fresh buffer each time). */
function decoderFor(pcm: (seed: number) => AudioBuffer) {
  return vi.fn(async (bytes: ArrayBuffer, _sampleRate: number) => pcm(new Uint8Array(bytes)[0]))
}

describe('assets keep metadata and peaks, not PCM', () => {
  it('creates an asset from a decode without referencing the AudioBuffer, and caches the PCM for the work that follows', async () => {
    const cache = new AssetPcmCache({ idleMs: 0 })
    const pcm = fakePcm([ramp(5000), ramp(5000, .5)], 44100)
    const asset = createAudioAsset('a', 'take.wav', new Blob(['x']), pcm, cache)
    expect(asset).toMatchObject({ id: 'a', name: 'take.wav', sampleRate: 44100, numberOfChannels: 2, length: 5000, duration: 5000 / 44100 })
    expect(Object.values(asset)).not.toContain(pcm)
    expect(asset.peaks).toEqual(overviewPeaks([pcm.getChannelData(0), pcm.getChannelData(1)], 5000))
    expect(asset.peaks).toHaveLength(320)
    expect(pyramidMax(asset.pyramid!)).toBe(Math.fround(Math.max(...ramp(5000).map(Math.abs))))
    expect(cache.peek(asset)).toBe(pcm)
    await expect(cache.get(asset)).resolves.toBe(pcm)
    expect(cache.decodes).toBe(0)
  })

  it('lists the assets a project plays, frozen renders included', () => {
    const clip = (assetId: string): AudioClip => ({ id: assetId, kind: 'audio', name: assetId, assetId, startBeat: 0, lengthBeats: 1, offsetSeconds: 0, gain: 1, fadeIn: 0, fadeOut: 0 })
    const track = { ...createTrack('audio'), clips: [clip('one'), clip('two')], render: { frozen: { assetId: 'frozen' } } } as unknown as ReturnType<typeof createTrack>
    expect([...referencedAssetIds({ ...createEmptyProject(), tracks: [track] })].sort()).toEqual(['frozen', 'one', 'two'])
  })
})

describe('on-demand PCM loader', () => {
  const frames = 1000
  const make = (seed: number) => fakePcm([ramp(frames, seed / 10)])

  it('decodes from the asset bytes at the asset rate, once for concurrent requests', async () => {
    const decode = decoderFor(make)
    const cache = new AssetPcmCache({ decode, idleMs: 0 })
    const asset = createAudioAsset('a', 'a', new Blob([new Uint8Array([3])]), make(3), null)
    const [first, second] = await Promise.all([cache.get(asset), cache.get(asset)])
    expect(first).toBe(second)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(decode.mock.calls[0][1]).toBe(48000)
    expect(Array.from(first.getChannelData(0))).toEqual(Array.from(make(3).getChannelData(0)))
    await cache.get(asset)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently used PCM beyond the budget but always keeps the newest', async () => {
    const decode = decoderFor(make)
    const cache = new AssetPcmCache({ decode, idleMs: 0, budgetBytes: pcmBytes(make(1)) * 2 })
    const assets = [1, 2, 3].map(seed => createAudioAsset(`a${seed}`, 'a', new Blob([new Uint8Array([seed])]), make(seed), null))
    await cache.get(assets[0]); await cache.get(assets[1])
    await cache.get(assets[0]) // a1 is now the most recent
    await cache.get(assets[2])
    expect(cache.size).toBe(2)
    expect(cache.peek(assets[1])).toBeUndefined()
    expect(cache.peek(assets[0])).toBeDefined()
    expect(cache.bytes).toBe(pcmBytes(make(1)) * 2)
    const tight = new AssetPcmCache({ decode, idleMs: 0, budgetBytes: 1 })
    await tight.get(assets[0]); await tight.get(assets[1])
    expect(tight.size).toBe(1)
    expect(tight.peek(assets[1])).toBeDefined()
  })

  it('releases PCM nobody used for the idle time, and on request', async () => {
    let now = 0
    vi.useFakeTimers()
    try {
      const cache = new AssetPcmCache({ decode: decoderFor(make), idleMs: 1000, now: () => now })
      const a = createAudioAsset('a', 'a', new Blob([new Uint8Array([1])]), make(1), cache)
      const b = createAudioAsset('b', 'b', new Blob([new Uint8Array([2])]), make(2), cache)
      now = 600; cache.peek(b)
      now = 1000; vi.advanceTimersByTime(1000)
      expect(cache.peek(a)).toBeUndefined()
      expect(cache.peek(b)).toBeDefined()
      now = 5000; vi.advanceTimersByTime(5000)
      expect(cache.size).toBe(0)
      expect(cache.bytes).toBe(0)
      cache.seed(a, make(1)); cache.release(a)
      expect(cache.size).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('rejects a decode that does not match the asset, or unreadable bytes, without caching anything', async () => {
    const cache = new AssetPcmCache({ decode: async () => fakePcm([ramp(10)]), idleMs: 0 })
    const asset = createAudioAsset('a', 'take', new Blob(['x']), make(1), null)
    await expect(cache.get(asset)).rejects.toThrow('처음과 다릅니다')
    const failing = new AssetPcmCache({ decode: async () => { throw new Error('codec') }, idleMs: 0 })
    await expect(failing.get(asset)).rejects.toThrow('다시 디코드하지 못했습니다')
    const unreadable = { ...asset, blob: { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) } as unknown as Blob }
    await expect(cache.get(unreadable)).rejects.toThrow('읽지 못했습니다')
    expect(cache.size).toBe(0)
  })

  it('reports what the main thread holds per asset', () => {
    const cache = new AssetPcmCache({ idleMs: 0 })
    const pcm = fakePcm([ramp(48000), ramp(48000)])
    const asset = createAudioAsset('a', 'a', new Blob([new Uint8Array(1234)]), pcm, null)
    const before = assetMemory([asset], cache)
    expect(before.blobs).toBe(1234)
    expect(before.cachedPcm).toBe(0)
    expect(before.peaks).toBeLessThan(pcmBytes(pcm) / 30)
    cache.seed(asset, pcm)
    expect(assetMemory([asset], cache).cachedPcm).toBe(48000 * 2 * 4)
  })
})
