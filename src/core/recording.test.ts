import { describe, expect, it } from 'vitest'
import { positionAfter } from '../audio/math'
import { createEmptyProject, createTrack } from './project'
import { appendAudioRecording, recordingDraftPlacement, recordingStartBeat, type RecordingDraft } from './recording'
import { recordingPlacement } from './recordingOffset'
import type { AudioClip, Project, Track } from './types'

const audioClip = (id: string): AudioClip => ({ id, name: id, kind: 'audio', assetId: `${id}-asset`, startBeat: 0, lengthBeats: 2, offsetSeconds: 0, gain: 1, fadeIn: 0, fadeOut: 0 })
const audioTrack = (patch: Partial<Track> = {}): Track => ({ ...createTrack('audio'), id: 'audio', ...patch })
const project = (...tracks: Track[]): Project => ({ ...createEmptyProject(), id: 'project', bpm: 120, lengthBeats: 8, tracks })
const take = (patch: Partial<RecordingDraft> = {}): RecordingDraft => ({
  id: 'recorded-region', name: 'Recording 12:00', trackId: 'audio', track: audioTrack(),
  startBeat: 2, bpm: 120, offsetMs: 0, startedAtMs: 1000, status: 'recording', ...patch,
})

describe('recording start and temporary region', () => {
  it('uses the playback start at the project end and at or beyond a cycle end', () => {
    const p = project()
    expect(recordingStartBeat(p, 3)).toBe(3)
    expect(recordingStartBeat(p, p.lengthBeats)).toBe(0)
    expect(recordingStartBeat(p, p.lengthBeats + 2)).toBe(0)
    const looping = { ...p, loop: { enabled: true, startBeat: 2, endBeat: 6 } }
    expect(recordingStartBeat(looping, 1)).toBe(1)
    expect(recordingStartBeat(looping, 4)).toBe(4)
    expect(recordingStartBeat(looping, 6)).toBe(2)
    expect(recordingStartBeat(looping, 8)).toBe(2)
  })

  it('begins with zero length and uses the same signed placement correction as the final audio', () => {
    const draft = take({ startBeat: 0, offsetMs: 125 })
    expect(recordingDraftPlacement(draft, 1000)).toEqual({ startBeat: .25, lengthBeats: 0, offsetSeconds: 0, elapsedSeconds: 0 })
    for (const offsetMs of [-500, 0, 125]) {
      const corrected = take({ startBeat: .25, offsetMs })
      expect(recordingDraftPlacement(corrected, 3000)).toEqual({ ...recordingPlacement(.25, 120, 2, offsetMs), elapsedSeconds: 2 })
    }
  })

  it('keeps zero visible length until a negative offset crosses time zero, then reveals only the audible portion', () => {
    const draft = take({ startBeat: 0, offsetMs: -500 })
    expect(recordingDraftPlacement(draft, 900)).toEqual({ startBeat: 0, lengthBeats: 0, offsetSeconds: .5, elapsedSeconds: 0 })
    expect(recordingDraftPlacement(draft, 1250)).toEqual({ startBeat: 0, lengthBeats: 0, offsetSeconds: .5, elapsedSeconds: .25 })
    expect(recordingDraftPlacement(draft, 1750)).toEqual({ startBeat: 0, lengthBeats: .5, offsetSeconds: .5, elapsedSeconds: .75 })
  })

  it('grows continuously while the playback cursor cycles or reaches the project end', () => {
    const draft = take({ startBeat: 2 })
    const looping = { ...project(), loop: { enabled: true, startBeat: 2, endBeat: 6 } }
    expect(positionAfter(looping, 2, 5)).toBe(4)
    expect(positionAfter(project(), 2, 5)).toBe(8)
    expect(recordingDraftPlacement(draft, 6000)).toEqual({ startBeat: 2, lengthBeats: 10, offsetSeconds: 0, elapsedSeconds: 5 })
    expect(recordingDraftPlacement(draft, 7000).lengthBeats).toBe(12)
  })

  it('freezes processing geometry at the captured stop time while decoding is pending', () => {
    const draft = take({ status: 'processing', elapsedSeconds: 1.25 })
    const stopped = { startBeat: 2, lengthBeats: 2.5, offsetSeconds: 0, elapsedSeconds: 1.25 }
    expect(recordingDraftPlacement(draft, 5000)).toEqual(stopped)
    expect(recordingDraftPlacement(draft, 100_000)).toEqual(stopped)
    expect(recordingDraftPlacement(take({ status: 'processing' }), 100_000).lengthBeats).toBe(0)
  })
})

describe('completed audio recording', () => {
  it('adds the stable take to the current audio track, unhides it, and preserves current track edits', () => {
    const previousClip = audioClip('old')
    const target = audioTrack({ name: 'Updated name', hidden: true, pan: .3, clips: [previousClip] })
    const untouched = audioTrack({ id: 'other' })
    const original = project(target, untouched)
    const result = appendAudioRecording(original, take({ startBeat: 7 }), 'recorded-asset', 2)!
    expect(result.clip).toEqual({ id: 'recorded-region', name: 'Recording 12:00', kind: 'audio', assetId: 'recorded-asset', startBeat: 7, lengthBeats: 4, offsetSeconds: 0, gain: 1, fadeIn: .005, fadeOut: .01 })
    expect(result.project.lengthBeats).toBe(12)
    expect(result.project.tracks[0]).toMatchObject({ id: 'audio', name: 'Updated name', hidden: false, pan: .3 })
    expect(result.project.tracks[0].clips).toEqual([previousClip, result.clip])
    expect(result.project.tracks[1]).toBe(untouched)
    expect(original.tracks[0]).toBe(target)
    expect(target.hidden).toBe(true)
    expect(target.clips).toEqual([previousClip])
  })

  it('creates a reserved audio track only with the final region and keeps its reserved identity', () => {
    const original = project()
    const reserved = audioTrack({ id: 'reserved-audio', name: 'New recording', color: '#DF5435', hidden: true })
    const draft = take({ trackId: reserved.id, track: reserved })
    recordingDraftPlacement(draft, 2000)
    expect(original.tracks).toEqual([])
    const result = appendAudioRecording(original, draft, 'asset', 1)!
    expect(result.project.tracks).toEqual([{ ...reserved, hidden: false, clips: [result.clip] }])
    expect(original.tracks).toEqual([])
  })

  it('recovers a deleted destination without resurrecting its old clips', () => {
    const previous = audioTrack({ name: 'Deleted track', clips: [audioClip('removed')] })
    const survivor = audioTrack({ id: 'survivor' })
    const result = appendAudioRecording(project(survivor), take({ track: previous }), 'asset', 1)!
    expect(result.project.tracks[0]).toBe(survivor)
    expect(result.project.tracks[1]).toMatchObject({ id: previous.id, name: previous.name, clips: [result.clip], hidden: false })
  })

  it('commits a take only once even when finalization is delivered again', () => {
    const draft = take()
    const once = appendAudioRecording(project(audioTrack()), draft, 'asset', 1)!
    const again = appendAudioRecording(once.project, draft, 'retried-asset', 1)!
    expect(again.project).toBe(once.project)
    expect(again.clip).toBe(once.clip)
    expect(again.project.tracks[0].clips).toHaveLength(1)
  })

  it('applies negative correction at zero without stretching the source or saving an inaudible take', () => {
    const original = project(audioTrack())
    const draft = take({ startBeat: .25, offsetMs: -500 })
    expect(appendAudioRecording(original, draft, 'asset', .25)).toBeNull()
    expect(original.tracks[0].clips).toEqual([])
    const result = appendAudioRecording(original, draft, 'asset', 2)!
    expect(result.clip).toMatchObject({ startBeat: 0, lengthBeats: 3.25, offsetSeconds: .375 })
  })

  it('rejects invalid audio duration and a conflicting non-audio destination', () => {
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(() => appendAudioRecording(project(), take(), 'asset', duration)).toThrow('유효한 길이')
    }
    const instrument = { ...createTrack('instrument'), id: 'audio' }
    expect(() => appendAudioRecording(project(instrument), take(), 'asset', 1)).toThrow('오디오 트랙')
  })
})
