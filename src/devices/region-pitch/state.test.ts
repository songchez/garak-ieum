import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, validateProject } from '../../core/project'
import { ProjectSession } from '../../core/ProjectSession'
import type { AudioAsset, AudioClip, Project } from '../../core/types'
import { applyWarpRender, groupFor, isIdentityGroup, pendingGroups, referencedAssets, renderJob, renderTimeRatio } from '../audio-warp/renderPlan'
import { attachWarpTempo, disableWarp, enableWarp } from '../audio-warp/state'
import { assetScale, formatTranspose, normalizeTranspose, setClipTranspose, shiftTranspose, transposeRate, transposeSettings, validateTranspose, type TransposeSettings } from './state'

const BPM = 120
const asset = (id: string) => ({ id } as AudioAsset)
const base = (patch: Partial<AudioClip> = {}): AudioClip => ({ id: 'a', kind: 'audio', name: 'a', startBeat: 4, lengthBeats: 8, gain: 1, assetId: 'orig', offsetSeconds: 1, fadeIn: 0.01, fadeOut: 0.02, ...patch })
const project = (...clips: AudioClip[]): Project => ({ ...createEmptyProject(), bpm: BPM, lengthBeats: 64, tracks: [{ ...createTrack('audio'), id: 't', clips }] })
const clipsOf = (value: Project) => value.tracks[0].clips as AudioClip[]
const set = (clip: AudioClip, patch: Partial<TransposeSettings>) => setClipTranspose(clip, { ...transposeSettings(clip), ...patch })
/** The renderer: installs one fake asset per group as a live change. */
function render(session: ProjectSession, available: Map<string, AudioAsset>) {
  for (const group of pendingGroups(session.getSnapshot().history.present, available)) {
    const id = isIdentityGroup(group) ? group.originalAssetId : `r:${group.key}`
    available.set(id, asset(id))
    session.dispatch({ type: 'live', edit: current => applyWarpRender(current, group, id, available) })
  }
}
/** Original-file second heard at a timeline second inside the region (first pass). */
const sourceAt = (clip: AudioClip, timelineSeconds: number) => (clip.offsetSeconds + timelineSeconds) / assetScale(clip) * (1)

describe('region pitch settings', () => {
  it('clamps to ±24 semitones / ±50 cents and formats', () => {
    expect(normalizeTranspose({ semitones: 30, cents: 70, mode: 'keep', formant: false })).toEqual({ semitones: 24, cents: 0, mode: 'keep', formant: false })
    expect(normalizeTranspose({ semitones: -3.4, cents: -12.6, mode: 'varispeed', formant: true })).toEqual({ semitones: -3, cents: -13, mode: 'varispeed', formant: false })
    expect(shiftTranspose({ semitones: 20, cents: 0, mode: 'keep', formant: false }, 12).semitones).toBe(24)
    expect(formatTranspose({ semitones: 3, cents: 0 })).toBe('+3')
    expect(formatTranspose({ semitones: -2, cents: 15 })).toBe('−2+15¢')
    expect(transposeRate({ semitones: 12, cents: 0, mode: 'varispeed' })).toBe(2)
    expect(transposeRate({ semitones: 12, cents: 0, mode: 'keep' })).toBe(1)
  })

  it('varispeed scales length and manual loop end by oldRate / newRate; keep tempo does not', () => {
    const looped = base({ loop: true, loopLengthBeats: 24 })
    const up = set(looped, { semitones: 12, mode: 'varispeed' })
    expect(up).toMatchObject({ lengthBeats: 4, loopLengthBeats: 12, startBeat: 4, assetId: 'orig', offsetSeconds: 1 })
    const down = set(up, { semitones: -12 })
    expect(down.lengthBeats).toBeCloseTo(16, 12)
    expect(down.loopLengthBeats).toBeCloseTo(48, 12)
    // Varispeed → keep tempo at the same pitch restores the original length.
    const keep = set(down, { mode: 'keep' })
    expect(keep.lengthBeats).toBeCloseTo(8, 12)
    const kept = set(base(), { semitones: 5 })
    expect(kept.lengthBeats).toBe(8)
    expect(kept.regionPitch).toEqual({ semitones: 5, cents: 0, mode: 'keep', originalAssetId: 'orig' })
  })

  it('refuses clips with note pitch edits', () => {
    const clip = { ...base(), pitch: {} as AudioClip['pitch'] }
    expect(set(clip, { semitones: 3 })).toBe(clip)
  })

  it('resetting an unrendered transposition removes it', () => {
    const clip = set(set(base(), { semitones: 4 }), { semitones: 0 })
    expect(clip.regionPitch).toBeUndefined()
  })
})

describe('region pitch render plan', () => {
  it('keep tempo: one render with stretch = warp × pitch, then resampled by pitch', () => {
    const warped = enableWarp(attachWarpTempo(base({ offsetSeconds: 0 }), { bpm: 100, confidence: 1, firstBeatSeconds: 0 }), BPM)
    const clip = set(warped, { semitones: 7 })
    const group = groupFor(clip, BPM)
    expect(group).toMatchObject({ tempoDependent: true, warpRatio: 100 / 120, cents: 700, mode: 'keep' })
    const job = renderJob(group)
    expect(job.pitch).toBeCloseTo(2 ** (7 / 12), 12)
    expect(job.stretch).toBeCloseTo(100 / 120 * 2 ** (7 / 12), 12)
    expect(renderTimeRatio(group)).toBeCloseTo(100 / 120, 12)
    expect(pendingGroups(project(clip), new Map([['orig', asset('orig')]]))).toHaveLength(1)
  })

  it('varispeed: stretch = warp only; render length = warp / rate; formant ignored', () => {
    const clip = set(base(), { semitones: -12, mode: 'varispeed', formant: true })
    const group = groupFor(clip, BPM)
    expect(group).toMatchObject({ tempoDependent: false, warpRatio: 1, cents: -1200, mode: 'varispeed', formant: false })
    expect(renderJob(group)).toEqual({ stretch: 1, pitch: 0.5, formantSemitones: null })
    expect(renderTimeRatio(group)).toBe(2)
    expect(renderJob({ warpRatio: 1, cents: 300, mode: 'keep', formant: true }).formantSemitones).toBe(-3)
  })

  it('shares one render between clips of the same file and settings; tempo changes do not re-render plain transpositions', () => {
    const a = set(base(), { semitones: 2 }), b = set(base({ id: 'b', startBeat: 20 }), { semitones: 2 }), c = set(base({ id: 'c', startBeat: 40 }), { semitones: 3 })
    const available = new Map([['orig', asset('orig')]])
    const value = project(a, b, c)
    expect(pendingGroups(value, available)).toHaveLength(2)
    const g = groupFor(a, BPM)
    expect(groupFor(a, 90).key).toBe(g.key)
    const next = applyWarpRender({ ...value, bpm: 90 }, g, 'r2', new Map([...available, ['r2', asset('r2')]]))
    expect(clipsOf(next).map(clip => clip.assetId)).toEqual(['r2', 'r2', 'orig'])
  })
})

describe('region pitch install, offsets, loops and undo', () => {
  it('varispeed keeps the same source material at the region start and end through install', () => {
    const available = new Map([['orig', asset('orig')]])
    const session = new ProjectSession(project(base({ loop: true, loopLengthBeats: 32 })))
    const before = clipsOf(session.getSnapshot().history.present)[0]
    const beforeEnd = sourceAt(before, before.lengthBeats * 60 / BPM)
    session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [set(clipsOf(current)[0], { semitones: 12, mode: 'varispeed' })] }] }), '', '피치 +12')
    render(session, available)
    const after = clipsOf(session.getSnapshot().history.present)[0]
    expect(after.assetId).not.toBe('orig')
    expect(after.offsetSeconds).toBeCloseTo(0.5, 12)
    expect(after.lengthBeats).toBe(4)
    expect(after.loopLengthBeats).toBe(16)
    expect(after.regionPitch?.rendered).toEqual({ cents: 1200, mode: 'varispeed', formant: false })
    // Region start and end hear the same original seconds as before; each loop pass repeats them.
    expect(sourceAt(after, 0)).toBeCloseTo(sourceAt(before, 0), 12)
    expect(sourceAt(after, after.lengthBeats * 60 / BPM)).toBeCloseTo(beforeEnd, 12)
    // Fades and gain stay in timeline seconds.
    expect(after).toMatchObject({ fadeIn: 0.01, fadeOut: 0.02, gain: 1 })
    expect(() => validateProject(session.getSnapshot().history.present)).not.toThrow()
    // One user step; the render install is live (no extra undo entry).
    expect(session.getSnapshot().history.past).toHaveLength(1)
    session.dispatch({ type: 'undo' })
    expect(clipsOf(session.getSnapshot().history.present)[0]).toEqual(before)
    session.dispatch({ type: 'redo' })
    expect(clipsOf(session.getSnapshot().history.present)[0]).toEqual(after)
  })

  it('moving between renders converts offsets; reset returns to the original file', () => {
    const available = new Map([['orig', asset('orig')]])
    const session = new ProjectSession(project(base()))
    const edit = (patch: Partial<TransposeSettings>) => { session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [set(clipsOf(current)[0], patch)] }] })); render(session, available) }
    edit({ semitones: -7, mode: 'varispeed' })
    const down = clipsOf(session.getSnapshot().history.present)[0]
    expect(down.offsetSeconds).toBeCloseTo(1 / 2 ** (-7 / 12), 12)
    edit({ mode: 'keep' })
    const keep = clipsOf(session.getSnapshot().history.present)[0]
    expect(keep.offsetSeconds).toBeCloseTo(1, 12)
    expect(keep.lengthBeats).toBeCloseTo(8, 12)
    edit({ semitones: 0 })
    const reset = clipsOf(session.getSnapshot().history.present)[0]
    expect(reset).toMatchObject({ assetId: 'orig', offsetSeconds: 1, lengthBeats: 8 })
    expect(reset.regionPitch).toBeUndefined()
    for (const state of [...session.getSnapshot().history.past, session.getSnapshot().history.present]) expect(() => validateProject(state)).not.toThrow()
    expect(referencedAssets(session.getSnapshot()).size).toBe(3)
  })

  it('warp toggles keep the transposition and render warp + pitch together', () => {
    const available = new Map([['orig', asset('orig')]])
    const tempo = attachWarpTempo(base({ offsetSeconds: 0 }), { bpm: 100, confidence: 1, firstBeatSeconds: 0 })
    const session = new ProjectSession(project(set(tempo, { semitones: 12, mode: 'varispeed' })))
    render(session, available)
    const vari = clipsOf(session.getSnapshot().history.present)[0]
    expect(vari.regionPitch?.rendered?.cents).toBe(1200)
    session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [enableWarp(clipsOf(current)[0], BPM)] }] }))
    const enabled = clipsOf(session.getSnapshot().history.present)[0]
    // Plays the original until the combined render arrives; warp keeps the varispeed length ratio.
    expect(enabled).toMatchObject({ assetId: 'orig', lengthBeats: vari.lengthBeats * 100 / 120 })
    expect(enabled.regionPitch?.rendered).toBeUndefined()
    expect(() => validateProject(session.getSnapshot().history.present)).not.toThrow()
    render(session, available)
    const both = clipsOf(session.getSnapshot().history.present)[0]
    expect(both.assetId).toBe(`r:orig|100|120|1200|varispeed`)
    expect(both.warp?.renderBpm).toBe(120)
    session.edit(current => ({ ...current, tracks: [{ ...current.tracks[0], clips: [disableWarp(clipsOf(current)[0], BPM)] }] }))
    const off = clipsOf(session.getSnapshot().history.present)[0]
    expect(off).toMatchObject({ assetId: 'orig', offsetSeconds: 0 })
    expect(off.lengthBeats).toBeCloseTo(vari.lengthBeats, 12)
    expect(() => validateProject(session.getSnapshot().history.present)).not.toThrow()
  })
})

describe('region pitch schema', () => {
  it('migrates older projects without transposition and round-trips schema 12', () => {
    const v11 = { ...JSON.parse(JSON.stringify(project(base()))), schemaVersion: 11 }
    const loaded = validateProject(v11)
    expect(loaded.schemaVersion).toBe(13)
    expect(clipsOf(loaded)[0].regionPitch).toBeUndefined()
    expect(transposeSettings(clipsOf(loaded)[0])).toEqual({ semitones: 0, cents: 0, mode: 'keep', formant: false })
    const transposed = project({ ...base({ assetId: 'r' }), regionPitch: { semitones: 3, cents: -20, mode: 'varispeed', originalAssetId: 'orig', rendered: { cents: 280, mode: 'varispeed', formant: false } } })
    expect(clipsOf(validateProject(JSON.parse(JSON.stringify(transposed))))[0].regionPitch).toEqual(clipsOf(transposed)[0].regionPitch)
    expect(() => validateProject({ ...JSON.parse(JSON.stringify(transposed)), schemaVersion: 11 })).toThrow(/schema version 12/)
  })

  it('rejects invalid values and inconsistent renders', () => {
    expect(() => validateTranspose({ semitones: 25, cents: 0, mode: 'keep', originalAssetId: 'o' })).toThrow()
    expect(() => validateTranspose({ semitones: 0, cents: 51, mode: 'keep', originalAssetId: 'o' })).toThrow()
    expect(() => validateTranspose({ semitones: 1, cents: 0, mode: 'fast', originalAssetId: 'o' })).toThrow()
    const missingRender = project({ ...base(), regionPitch: { semitones: 3, cents: 0, mode: 'keep', originalAssetId: 'orig', rendered: { cents: 300, mode: 'keep', formant: false } } })
    expect(() => validateProject(JSON.parse(JSON.stringify(missingRender)))).toThrow(/missing its pitch render/)
    const strayRender = project({ ...base({ assetId: 'r' }), regionPitch: { semitones: 3, cents: 0, mode: 'keep', originalAssetId: 'orig' } })
    expect(() => validateProject(JSON.parse(JSON.stringify(strayRender)))).toThrow(/without a transposition/)
  })
})
