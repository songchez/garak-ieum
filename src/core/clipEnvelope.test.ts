import { describe, expect, it } from 'vitest'
import { AUDIO_CLIP_GAIN_MAX, crossfadeClips, envelopeAt, envelopeBreakpoints, fadeLengths, fadeShape, normalizeGain, regionPeak, withClipGainDb, withFade, withFadeCurve } from './clipEnvelope'
import { audioWindows } from './playback'
import { applyDragMode, createEmptyProject, createTrack, joinClips, validateProject } from './project'
import type { AudioClip, MidiClip, Project } from './types'

const audio = (id: string, patch: Partial<AudioClip> = {}): AudioClip => ({ id, kind: 'audio', name: id, assetId: 'a', startBeat: 0, lengthBeats: 4, gain: 1, offsetSeconds: 0, fadeIn: 0, fadeOut: 0, ...patch })
function projectWith(...clips: AudioClip[]): Project {
  const project = createEmptyProject()
  project.bpm = 120
  project.tracks = [{ ...createTrack('audio'), id: 'track', clips }]
  return project
}
const clipsOf = (project: Project) => Object.fromEntries(project.tracks[0].clips.map(c => [c.id, c as AudioClip]))

describe('fade shapes', () => {
  it('runs from silence to full level for every curve and keeps equal-power pairs at constant power', () => {
    for (const curve of ['linear', 'equalPower', 'sCurve', 'exponential', 'logarithmic'] as const) {
      expect(fadeShape(curve, 0)).toBeCloseTo(0, 12)
      expect(fadeShape(curve, 1)).toBeCloseTo(1, 12)
    }
    for (const x of [0.1, 0.37, 0.5, 0.9]) expect(fadeShape('equalPower', x) ** 2 + fadeShape('equalPower', 1 - x) ** 2).toBeCloseTo(1, 12)
    expect(fadeShape('sCurve', 0.25)).toBeCloseTo((1 - Math.cos(Math.PI / 4)) / 2)
    expect(fadeShape('exponential', 0.5)).toBe(0.25)
    expect(fadeShape('logarithmic', 0.5)).toBe(0.75)
    expect(fadeShape(undefined, 0.3)).toBe(0.3)
  })

  it('shrinks overlapping fades in proportion and evaluates curved fade-outs from the region end', () => {
    expect(fadeLengths(1, 0.2, 0.3)).toEqual([0.2, 0.3])
    const [a, b] = fadeLengths(1, 0.5, 3)
    expect(a).toBeCloseTo(1 / 3); expect(b).toBeCloseTo(2 / 3)
    expect(envelopeAt(0.9, 1, 0, 0.4, undefined, 'equalPower')).toBeCloseTo(Math.sin(0.25 * Math.PI / 2))
    expect(envelopeAt(0.5, 1, 0.2, 0.2)).toBe(1)
  })

  it('adds curve segments only for curved fades', () => {
    expect(envelopeBreakpoints(2, 0.5, 0.5)).toEqual([0, 0.5, 1.5, 2])
    const curved = envelopeBreakpoints(2, 0.5, 0, 'sCurve', undefined, 4)
    expect(curved).toEqual([0, 0.125, 0.25, 0.375, 0.5, 2])
  })
})

describe('region gain and fade edits', () => {
  it('limits audio gain to +24 dB, MIDI gain to 2 and treats −60 dB as silence', () => {
    expect(withClipGainDb(audio('a'), 6).gain).toBeCloseTo(10 ** (6 / 20))
    expect(withClipGainDb(audio('a'), 40).gain).toBeCloseTo(AUDIO_CLIP_GAIN_MAX)
    expect(withClipGainDb(audio('a'), -60).gain).toBe(0)
    const midi: MidiClip = { id: 'm', kind: 'midi', name: 'm', startBeat: 0, lengthBeats: 4, gain: 1, notes: [] }
    expect(withClipGainDb(midi, 12).gain).toBe(2)
    const same = audio('a')
    expect(withClipGainDb(same, 0)).toBe(same)
  })

  it('lets one fade use what the other leaves and stores linear curves as absent', () => {
    const clip = audio('a', { fadeOut: 0.5 })
    expect(withFade(clip, 'in', 5, 2).fadeIn).toBe(1.5)
    expect(withFade(clip, 'in', -1, 2).fadeIn).toBe(0)
    const curved = withFadeCurve(clip, 'out', 'sCurve')
    expect(curved.fadeOutCurve).toBe('sCurve')
    expect('fadeOutCurve' in withFadeCurve(curved, 'out', 'linear')).toBe(false)
    expect(withFadeCurve(clip, 'in', 'linear')).toBe(clip)
  })

  it('normalizes the visible source range to −0.1 dBFS', () => {
    const data = new Float32Array(100); data[10] = 0.9; data[60] = -0.25
    expect(regionPeak([data], 100, 0, 1)).toBeCloseTo(0.9)
    expect(regionPeak([data], 100, 0.5, 0.5)).toBeCloseTo(0.25)
    expect(normalizeGain(0.25)! * 0.25).toBeCloseTo(10 ** (-0.1 / 20))
    expect(normalizeGain(0)).toBeNull()
    expect(normalizeGain(1e-5)).toBe(AUDIO_CLIP_GAIN_MAX)
  })

  it('joins regions keeping the last fade-out shape', () => {
    const joined = joinClips([audio('a', { fadeInCurve: 'sCurve', fadeOutCurve: 'exponential' }), audio('b', { startBeat: 4, offsetSeconds: 2, fadeOut: 0.3, fadeOutCurve: 'logarithmic' })], 120) as AudioClip
    expect(joined).toMatchObject({ fadeInCurve: 'sCurve', fadeOut: 0.3, fadeOutCurve: 'logarithmic', lengthBeats: 8 })
  })
})

describe('crossfades', () => {
  it('crossfades overlapping selected regions over the overlap with equal power', () => {
    const { project, count } = crossfadeClips(projectWith(audio('a'), audio('b', { startBeat: 3 })), new Set(['a', 'b']), () => Infinity)
    expect(count).toBe(1)
    const { a, b } = clipsOf(project)
    expect(a).toMatchObject({ fadeOut: 0.5, fadeOutCurve: 'equalPower' })
    expect(b).toMatchObject({ fadeIn: 0.5, fadeInCurve: 'equalPower', startBeat: 3 })
  })

  it('extends touching regions into their source handles and skips gaps', () => {
    const touching = projectWith(audio('a'), audio('b', { startBeat: 4, offsetSeconds: 2 }))
    const { project } = crossfadeClips(touching, new Set(['a', 'b']), () => 10, 0.02)
    const { a, b } = clipsOf(project)
    expect(a.lengthBeats).toBeCloseTo(4.02); expect(b.startBeat).toBeCloseTo(3.98); expect(b.offsetSeconds).toBeCloseTo(1.99)
    expect(a.fadeOut).toBeCloseTo(0.02); expect(b.fadeIn).toBeCloseTo(0.02)
    // A split of one continuous take sums back without a bump: equal gain, not equal power.
    expect(a.fadeOutCurve).toBeUndefined(); expect(b.fadeInCurve).toBeUndefined()
    // No handle on the right region: the left region takes the whole crossfade.
    const noHandle = clipsOf(crossfadeClips(projectWith(audio('a'), audio('b', { startBeat: 4 })), new Set(['a', 'b']), () => 10, 0.02).project)
    expect(noHandle.a.lengthBeats).toBeCloseTo(4.04); expect(noHandle.b.startBeat).toBe(4)
    expect(crossfadeClips(projectWith(audio('a'), audio('b', { startBeat: 5 })), new Set(['a', 'b']), () => 10).count).toBe(0)
  })

  it('keeps the earlier region sounding under the later fade-in only when the tempo is known', () => {
    const track = projectWith(audio('a', { fadeOut: 0.5 }), audio('b', { startBeat: 3, fadeIn: 0.5 })).tracks[0]
    expect(audioWindows(track, 64).map(w => [w.clip.id, w.start, w.end])).toEqual([['a', 0, 3], ['b', 3, 7]])
    expect(audioWindows(track, 64, 120).map(w => [w.clip.id, w.start, w.end])).toEqual([['a', 0, 4], ['b', 3, 7]])
  })

  it('crossfades partial overlaps in the X-Fade drag mode but still cuts covered regions', () => {
    const moved = applyDragMode(projectWith(audio('a'), audio('b', { startBeat: 3 })), ['track'], ['b'], 'crossfade')
    expect(clipsOf(moved).a).toMatchObject({ lengthBeats: 4, fadeOut: 0.5, fadeOutCurve: 'equalPower' })
    expect(clipsOf(moved).b).toMatchObject({ fadeIn: 0.5 })
    const covered = applyDragMode(projectWith(audio('a', { lengthBeats: 8 }), audio('b', { startBeat: 2, lengthBeats: 2 })), ['track'], ['b'], 'crossfade')
    expect(covered.tracks[0].clips.map(c => [c.id === 'b' ? 'b' : 'piece', c.startBeat, c.lengthBeats])).toEqual([['piece', 0, 2], ['piece', 4, 4], ['b', 2, 2]])
  })
})

describe('schema 10', () => {
  it('saves fade curves and region gain above +6 dB, and rejects them in older schemas', () => {
    const project = projectWith(audio('a', { gain: 8, fadeInCurve: 'equalPower', fadeOutCurve: 'linear' }))
    const loaded = validateProject(JSON.parse(JSON.stringify(project)))
    expect(loaded.schemaVersion).toBe(14)
    expect(loaded.tracks[0].clips[0]).toMatchObject({ gain: 8, fadeInCurve: 'equalPower' })
    expect('fadeOutCurve' in loaded.tracks[0].clips[0]).toBe(false)
    expect(() => validateProject({ ...project, schemaVersion: 9 })).toThrow(/gain|schema version 10/)
    expect(() => validateProject({ ...projectWith(audio('a', { fadeInCurve: 'sCurve' })), schemaVersion: 9 })).toThrow(/schema version 10/)
    expect(() => validateProject(projectWith(audio('a', { fadeInCurve: 'wobble' as never })))).toThrow(/fade in curve/)
  })

  it('loads schema 9 regions unchanged with linear fades', () => {
    const old = { ...projectWith(audio('a', { gain: 1.5, fadeIn: 0.01, fadeOut: 0.2 })), schemaVersion: 9 }
    expect(validateProject(old).tracks[0].clips[0]).toEqual(audio('a', { gain: 1.5, fadeIn: 0.01, fadeOut: 0.2 }))
  })
})
