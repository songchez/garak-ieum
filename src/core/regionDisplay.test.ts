import { describe, expect, it } from 'vitest'
import { clipOccurrences } from './playback'
import { previewRegionTracks, regionDisplayName } from './regionDisplay'
import { createTrack } from './project'
import type { AudioClip, MidiClip } from './types'

const midi = (patch: Partial<MidiClip> = {}): MidiClip => ({
  id: 'region', kind: 'midi', name: 'Keys', startBeat: 0, lengthBeats: 4, gain: 1, notes: [], ...patch,
})
const boundaries = (track: ReturnType<typeof createTrack>, clip: MidiClip, end = 32) =>
  clipOccurrences(track, clip, end).map(occ => [occ.start, occ.end])

describe('region display names', () => {
  it('shows positive and negative region transpose, and removes the suffix at zero', () => {
    expect(regionDisplayName(midi({ transpose: 12 }))).toBe('Keys (+12)')
    expect(regionDisplayName(midi({ transpose: -3 }))).toBe('Keys (-3)')
    expect(regionDisplayName(midi({ transpose: 0 }))).toBe('Keys')
    expect(regionDisplayName(midi())).toBe('Keys')
  })

  it('leaves audio names and the saved name intact', () => {
    const audio: AudioClip = { id: 'audio', kind: 'audio', name: 'Voice', startBeat: 0, lengthBeats: 4, gain: 1, assetId: 'asset', offsetSeconds: 0, fadeIn: 0, fadeOut: 0 }
    const clip = midi({ transpose: 5 })
    expect(regionDisplayName(audio)).toBe('Voice')
    expect(regionDisplayName(clip)).toBe('Keys (+5)')
    expect(clip.name).toBe('Keys')
  })
})

describe('loop previews use the playback track layout', () => {
  it('recalculates repeats after a resize, including the partial last repetition before a muted region', () => {
    const loop = midi({ loop: true })
    const next = midi({ id: 'next', startBeat: 11, mute: true })
    const owner = { ...createTrack('instrument'), clips: [loop, next] }
    const resized = { ...loop, lengthBeats: 3 }
    const view = previewRegionTracks([owner], new Map([[loop.id, { clip: resized, trackId: owner.id }]]), false)
    expect(boundaries(view.tracks.get(owner.id)!, resized)).toEqual([[0, 3], [3, 6], [6, 9], [9, 11]])
    expect(owner.clips).toEqual([loop, next])
    expect(loop.lengthBeats).toBe(4)
  })

  it('uses a moved region’s destination track and updates the original track’s looping predecessor', () => {
    const predecessor = midi({ id: 'before', startBeat: 0, lengthBeats: 2, loop: true })
    const moving = midi({ startBeat: 8, loop: true })
    const source = { ...createTrack('instrument'), clips: [predecessor, moving] }
    const destination = { ...createTrack('instrument'), clips: [midi({ id: 'next', startBeat: 15 })] }
    const moved = { ...moving, startBeat: 4 }
    const view = previewRegionTracks([source, destination], new Map([[moving.id, { clip: moved, trackId: destination.id }]]), false)
    expect(boundaries(view.tracks.get(destination.id)!, moved)).toEqual([[4, 8], [8, 12], [12, 15]])
    expect(boundaries(view.tracks.get(source.id)!, predecessor, 10)).toEqual([[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]])
    expect(source.clips).toHaveLength(2)
  })

  it('moves all selected boundaries together and does not invent a repeat inside an overlapping original', () => {
    const loop = midi({ startBeat: 2, loop: true })
    const next = midi({ id: 'next', startBeat: 12 })
    const owner = { ...createTrack('instrument'), clips: [loop, next] }
    const moved = { ...loop, startBeat: 6 }
    const view = previewRegionTracks([owner], new Map([
      [loop.id, { clip: moved, trackId: owner.id }],
      [next.id, { clip: { ...next, startBeat: 16 }, trackId: owner.id }],
    ]), false)
    expect(boundaries(view.tracks.get(owner.id)!, moved)).toEqual([[6, 10], [10, 14], [14, 16]])
    const overlap = { ...owner, clips: [loop, { ...next, startBeat: 4 }] }
    expect(boundaries(overlap, loop)).toEqual([[2, 6]])
  })

  it('keeps the original as a loop boundary when a copy is dragged before it', () => {
    const loop = midi({ startBeat: 8, loop: true })
    const owner = { ...createTrack('instrument'), clips: [loop] }
    const view = previewRegionTracks([owner], new Map([[loop.id, { clip: { ...loop, startBeat: 0 }, trackId: owner.id }]]), true)
    const copy = view.placements.get(loop.id)!.clip as MidiClip
    expect(copy.id).not.toBe(loop.id)
    expect(boundaries(view.tracks.get(owner.id)!, copy)).toEqual([[0, 4], [4, 8]])
    expect(view.tracks.get(owner.id)!.clips).toHaveLength(2)
    expect(owner.clips).toHaveLength(1)
  })
})
