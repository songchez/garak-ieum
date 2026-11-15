import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, splitClip, validateProject } from '../../core/project'
import type { AudioClip, Project } from '../../core/types'
import { adoptClipTempo, attachWarpTempo, clipAssetIds, clipWithWarpDecision, disableWarp, enableWarp, inheritWarp, setClipWarp, setWarpSourceBpm, validateWarp, warpNeedsRender, warpRatioSupported, withWarpRender } from './state'
import { importProjectBundle, exportProjectBundle } from '../../core/storage'

const clip = (patch: Partial<AudioClip> = {}): AudioClip => ({ id: 'c', kind: 'audio', name: 'loop', startBeat: 4, lengthBeats: 8, gain: 1, assetId: 'orig', offsetSeconds: 0, fadeIn: .005, fadeOut: .01, ...patch })
const detected = (sourceBpm = 100, patch: Partial<AudioClip> = {}) => attachWarpTempo(clip(patch), { bpm: sourceBpm, confidence: .8, firstBeatSeconds: .02 })
function project(...clips: AudioClip[]): Project {
  const base = createEmptyProject()
  return { ...base, bpm: 120, tracks: [{ ...createTrack('audio'), id: 'track', clips }] }
}

describe('warp clip transforms', () => {
  it('attaches a detected tempo without changing what plays', () => {
    const value = detected()
    expect(value.warp).toEqual({ enabled: false, sourceBpm: 100, firstBeatSeconds: .02, confidence: .8, originalAssetId: 'orig', renderBpm: 100 })
    expect(value).toMatchObject({ assetId: 'orig', lengthBeats: 8 })
  })

  it('enables warp with a beat length that follows the source tempo, and restores original timing when disabled', () => {
    // 8 beats at 120 BPM = 4 s of source = 6.667 beats at 100 BPM source tempo.
    const on = enableWarp(detected(100, { loopLengthBeats: 16 }), 120)
    expect(on.lengthBeats).toBeCloseTo(8 * 100 / 120)
    expect(on.loopLengthBeats).toBeCloseTo(16 * 100 / 120)
    expect(on.warp).toMatchObject({ enabled: true, renderBpm: 100 })
    expect(warpNeedsRender(on, 120)).toBe(true)
    const rendered = withWarpRender({ ...on, offsetSeconds: 1 }, 120, 'render-120')
    expect(rendered).toMatchObject({ assetId: 'render-120', warp: { renderBpm: 120 } })
    // One source second is 100/120 s in the faster render.
    expect(rendered.offsetSeconds).toBeCloseTo(100 / 120)
    expect(warpNeedsRender(rendered, 120)).toBe(false)
    const off = disableWarp(rendered, 120)
    expect(off).toMatchObject({ assetId: 'orig', warp: { enabled: false, renderBpm: 100 } })
    expect(off.offsetSeconds).toBeCloseTo(1)
    expect(off.lengthBeats).toBeCloseTo(8)
  })

  it('re-targets an existing render when the project tempo changes, and uses the original at the source tempo', () => {
    const at120 = withWarpRender({ ...enableWarp(detected(100), 120), offsetSeconds: .5 }, 120, 'r120')
    const at90 = withWarpRender(at120, 90, 'r90')
    expect(at120.offsetSeconds).toBeCloseTo(.5 * 100 / 120)
    expect(at90.offsetSeconds).toBeCloseTo(at120.offsetSeconds * 120 / 90)
    expect(at90.lengthBeats).toBe(at120.lengthBeats)
    const at100 = withWarpRender(at90, 100, 'unused')
    expect(at100).toMatchObject({ assetId: 'orig', warp: { renderBpm: 100 } })
    // Back at the source tempo, the offset is in original seconds again.
    expect(at100.offsetSeconds).toBeCloseTo(.5)
  })

  it('corrects the source tempo while keeping the visible source material', () => {
    const on = withWarpRender({ ...enableWarp(detected(100), 120), offsetSeconds: .5 }, 120, 'r120')
    const doubled = setWarpSourceBpm(on, 200)
    expect(doubled.lengthBeats).toBeCloseTo(on.lengthBeats * 2)
    expect(doubled).toMatchObject({ assetId: 'orig', warp: { sourceBpm: 200, renderBpm: 200, confidence: 0 } })
    // Pending again: the offset is in original-file seconds.
    expect(doubled.offsetSeconds).toBeCloseTo(.5)
    const off = setWarpSourceBpm(detected(100), 50)
    expect(off).toMatchObject({ assetId: 'orig', lengthBeats: 8, warp: { sourceBpm: 50, renderBpm: 50 } })
    expect(setWarpSourceBpm(off, 50)).toBe(off)
  })

  it('applies import decisions only within the supported stretch range', () => {
    const decision = { sourceBpm: 90, confidence: .8, firstBeatSeconds: 0, enabled: true, source: 'length' as const }
    expect(clipWithWarpDecision(clip(), decision, 120).warp?.enabled).toBe(true)
    expect(clipWithWarpDecision(clip(), { ...decision, enabled: false }, 120).warp?.enabled).toBe(false)
    expect(warpRatioSupported(60, 300)).toBe(false)
    expect(clipWithWarpDecision(clip(), { ...decision, sourceBpm: 60 }, 300).warp?.enabled).toBe(false)
  })

  it('lets the project adopt the clip tempo', () => {
    expect(adoptClipTempo(clip(), 120)).toBeNull()
    const off = adoptClipTempo(detected(100), 120)!
    expect(off.bpm).toBe(100)
    expect(off.clip.lengthBeats).toBeCloseTo(8 * 100 / 120)
    const on = enableWarp(detected(100), 120)
    expect(adoptClipTempo(on, 120)).toEqual({ bpm: 100, clip: on })
  })

  it('keeps the original asset referenced', () => {
    expect(clipAssetIds(withWarpRender(enableWarp(detected(), 120), 120, 'r'))).toEqual(['r', 'orig'])
    expect(clipAssetIds(detected())).toEqual(['orig'])
  })
})

describe('warp validation', () => {
  it('round-trips warped and detected clips through project validation', () => {
    const warped = withWarpRender(enableWarp(detected(), 120), 120, 'render')
    const value = project(warped, { ...detected(), id: 'd', startBeat: 20 })
    const loaded = validateProject(JSON.parse(JSON.stringify(value)))
    expect(loaded.schemaVersion).toBe(12)
    expect(loaded.tracks[0].clips).toEqual([warped, { ...detected(), id: 'd', startBeat: 20 }])
  })

  it('accepts a pending render (original audible at the source tempo)', () => {
    expect(() => validateProject(project(enableWarp(detected(), 120)))).not.toThrow()
  })

  it('rejects inconsistent warp state', () => {
    const base = detected()
    const bad = (warp: object, patch: Partial<AudioClip> = {}) => () => validateProject(project({ ...base, ...patch, warp: { ...base.warp!, ...warp } }))
    expect(bad({}, { assetId: 'other' })).toThrow(/while warp is off/)
    expect(bad({ renderBpm: 120 })).toThrow(/render tempo while warp is off/)
    expect(bad({ enabled: true, renderBpm: 120 })).toThrow(/missing its warp render/)
    expect(bad({ sourceBpm: 400 })).toThrow(/source tempo/)
    expect(bad({ confidence: 2 })).toThrow(/confidence/)
    expect(bad({ originalAssetId: '' })).toThrow(/original asset/)
    expect(bad({ enabled: 'yes' })).toThrow(/enabled/)
    expect(() => validateWarp(null)).toThrow(/object/)
    const pitch = { sourceAssetId: 'orig' }
    expect(() => validateProject(project({ ...base, pitch } as unknown as AudioClip))).toThrow()
  })

  it('requires schema 9 and leaves older projects unchanged', () => {
    const value = project(detected())
    expect(() => validateProject({ ...value, schemaVersion: 8 })).toThrow(/schema version 9/)
    const legacy = validateProject({ ...project(clip()), schemaVersion: 8 })
    expect(legacy.schemaVersion).toBe(12)
    expect(legacy.tracks[0].clips[0]).toEqual(clip())
    expect('warp' in legacy.tracks[0].clips[0]).toBe(false)
  })

  it('splits keep the warp so both halves stay on the same render', () => {
    const warped = withWarpRender(enableWarp(detected(), 120), 120, 'render')
    const [left, right] = splitClip(warped, warped.startBeat + 2, 120) as AudioClip[]
    expect(left.warp).toEqual(warped.warp)
    expect(right).toMatchObject({ assetId: 'render', warp: warped.warp, offsetSeconds: 1 })
    expect(() => validateProject(project(left, right))).not.toThrow()
  })

  it('refuses to save without the warp original', async () => {
    const warped = withWarpRender(enableWarp(detected(), 120), 120, 'render')
    const asset = (id: string) => ({ id, name: id, blob: new Blob(['x']), buffer: {} as AudioBuffer, peaks: [] })
    await expect(exportProjectBundle(project(warped), new Map([['render', asset('render')]]))).rejects.toThrow(/warped/)
    const bundle = await exportProjectBundle(project(warped), new Map([['render', asset('render')], ['orig', asset('orig')]]))
    const stored = await importProjectBundle(bundle)
    expect(stored.project.tracks[0].clips[0]).toEqual(warped)
  })
})

describe('warp switch and re-placed project audio', () => {
  it('toggles warp from the region badge and refuses unsupported ratios', () => {
    const on = setClipWarp(detected(100), true, 120)
    expect(on).toEqual(enableWarp(detected(100), 120))
    expect(setClipWarp(on, true, 120)).toBe(on)
    expect(setClipWarp(on, false, 120)).toEqual(disableWarp(on, 120))
    // 30 → 300 BPM is a tenfold stretch.
    const slow = detected(30)
    expect(setClipWarp(slow, true, 300)).toBe(slow)
    const plain = clip()
    expect(setClipWarp(plain, true, 120)).toBe(plain)
  })

  it('gives a re-placed file the tempo and warp state its existing region has', () => {
    const existing = withWarpRender(enableWarp(detected(100), 120), 120, 'render-120')
    const p = project(existing)
    const durations = (id: string) => id === 'orig' ? 4.8 : id === 'render-120' ? 4 : undefined
    // Placing either the original or its render: the original, warped (4.8 s at 100 BPM = 8 beats).
    for (const assetId of ['orig', 'render-120']) {
      const placed = inheritWarp(clip({ id: 'n', assetId, lengthBeats: 1, offsetSeconds: 0 }), p, durations)
      expect(placed).toMatchObject({ id: 'n', assetId: 'orig', lengthBeats: 8, warp: { enabled: true, sourceBpm: 100, renderBpm: 100, originalAssetId: 'orig' } })
      expect(validateProject(project(existing, { ...placed, startBeat: 20 }))).toBeTruthy()
    }
    // Existing region unwarped: only the tempo carries over.
    const off = inheritWarp(clip({ id: 'n', lengthBeats: 1 }), project(detected(100)), durations)
    expect(off).toMatchObject({ assetId: 'orig', lengthBeats: 4.8 * 2, warp: { enabled: false, sourceBpm: 100 } })
    // Unknown files are untouched.
    const other = clip({ id: 'n', assetId: 'other' })
    expect(inheritWarp(other, p, durations)).toBe(other)
  })
})
