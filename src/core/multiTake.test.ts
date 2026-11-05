import { describe, expect, it, vi } from 'vitest'
import type { AudioRecordingCallbacks } from '../audio/AudioRecording'
import { createEmptyProject, createTrack } from './project'
import { ProjectSession } from './ProjectSession'
import { appendAudioRecordings, createTakeCapture, selectInputChannels, simultaneousTakeLimit, type MultiTakeEngine, type RecordingDraft, type RecordingSession, type SingleCapture, type TakeCallbacks, type TakeResult } from './recording'
import type { Project, Track } from './types'

const audio = (id: string, patch: Partial<Track> = {}): Track => ({ ...createTrack('audio'), id, name: id, ...patch })
const project = (...tracks: Track[]): Project => ({ ...createEmptyProject(), id: 'project', bpm: 120, lengthBeats: 8, loop: { enabled: false, startBeat: 0, endBeat: 8 }, tracks })
const draft = (trackId: string, track: Track, patch: Partial<RecordingDraft> = {}): RecordingDraft => ({
  id: `take-${trackId}`, name: `${trackId} · Recording`, trackId, track, startBeat: 2, bpm: 120, offsetMs: 0, startedAtMs: 0, status: 'processing', ...patch,
})
const blob = () => new Blob([new Uint8Array(64)], { type: 'audio/wav' })

/** A stand-in for WP2's NativeAudioEngine.createRecordings: one record.start for every take. */
class FakeSession implements RecordingSession {
  started = false; stopped = false; disposed = false
  readonly startedAtMs = 1234
  readonly elapsedSeconds = 2
  readonly startFrame = 48_000
  readonly compensationKnown = true
  constructor(readonly trackIds: string[], private readonly callbacks: TakeCallbacks) {}
  async start() { this.started = true }
  stop() { this.stopped = true; this.callbacks.onComplete(this.trackIds.map(trackId => ({ trackId, blob: blob(), durationSeconds: 2, error: null }))) }
  dispose() { this.disposed = true }
  startFrameOf(trackId: string) { return trackId === 'b' ? 48_480 : this.startFrame }
}

class FakeSingle implements SingleCapture {
  started = false
  readonly startedAtMs = 99
  readonly elapsedSeconds = 1
  constructor(readonly trackId: string, private readonly callbacks: AudioRecordingCallbacks) {}
  start() { this.started = true }
  stop() { this.callbacks.onComplete({ blob: blob(), durationSeconds: 1, error: null }) }
  dispose() {}
}

describe('multi-take capture', () => {
  it('uses the engine session for several tracks and reports every take at once', async () => {
    const sessions: FakeSession[] = []
    const engine: MultiTakeEngine = { maxSimultaneousRecordings: 64, createRecordings: (ids, callbacks) => { const session = new FakeSession(ids, callbacks); sessions.push(session); return session } }
    const single = vi.fn()
    let results: TakeResult[] = []
    const capture = createTakeCapture(engine, ['a', 'b'], { onComplete: value => { results = value } }, single)
    await capture.start()
    expect(single).not.toHaveBeenCalled()
    expect(sessions[0]).toMatchObject({ trackIds: ['a', 'b'], started: true })
    expect([capture.startFrameOf('a'), capture.startFrameOf('b'), capture.compensationKnown, capture.startedAtMs]).toEqual([48_000, 48_480, true, 1234])
    capture.stop()
    expect(results.map(result => result.trackId)).toEqual(['a', 'b'])
  })

  it('falls back to the single recorder in a browser (one take, MediaRecorder path)', async () => {
    const web: MultiTakeEngine = { maxSimultaneousRecordings: 1 }
    expect(simultaneousTakeLimit(web)).toBe(1)
    expect(simultaneousTakeLimit({})).toBe(1)
    // A native engine without WP2's method keeps today's single NativeRecording path.
    expect(simultaneousTakeLimit({ maxSimultaneousRecordings: 64 })).toBe(1)
    expect(simultaneousTakeLimit({ maxSimultaneousRecordings: 64, createRecordings: () => { throw new Error('unused') } })).toBe(64)
    let made: FakeSingle | null = null
    let results: TakeResult[] = []
    const capture = createTakeCapture(web, ['a'], { onComplete: value => { results = value } }, (trackId, callbacks) => (made = new FakeSingle(trackId, callbacks)))
    await capture.start()
    expect(made).toMatchObject({ trackId: 'a', started: true })
    expect(capture.startFrameOf('a')).toBeNull()
    capture.stop()
    expect(results).toEqual([expect.objectContaining({ trackId: 'a', durationSeconds: 1 })])
    expect(() => createTakeCapture(web, ['a', 'b'], { onComplete: () => undefined }, () => new FakeSingle('a', { onComplete: () => undefined }))).toThrow(/동시에/)
  })

  it('commits every take of a pass as regions on their own tracks in one undo step', () => {
    const a = audio('a'), b = audio('b'), other = audio('other')
    const session = new ProjectSession(project(a, b, other))
    const before = session.getSnapshot().history.present
    const appended = appendAudioRecordings(before, [
      { draft: draft('a', a), assetId: 'asset-a', durationSeconds: 2 },
      { draft: draft('b', b, { startBeat: 2.02 }), assetId: 'asset-b', durationSeconds: 2 },
    ])
    expect(appended.clips.map(clip => clip.assetId)).toEqual(['asset-a', 'asset-b'])
    session.edit(() => appended.project, '', '오디오 녹음 (2개 트랙)')
    const after = session.getSnapshot().history.present
    expect(after.tracks.map(track => track.clips.map(clip => clip.id))).toEqual([['take-a'], ['take-b'], []])
    expect(session.getSnapshot().undoLabel).toBe('오디오 녹음 (2개 트랙)')
    session.dispatch({ type: 'undo' })
    expect(session.getSnapshot().history.present.tracks.every(track => track.clips.length === 0)).toBe(true)
  })

  it('skips takes placed wholly before the project start and recreates a track deleted mid-take', () => {
    const a = audio('a'), gone = audio('gone')
    const appended = appendAudioRecordings(project(a), [
      { draft: draft('a', a, { startBeat: 0, offsetMs: -5000 }), assetId: 'early', durationSeconds: 1 },
      { draft: draft('gone', gone), assetId: 'late', durationSeconds: 1 },
    ])
    expect(appended.skipped.map(take => take.trackId)).toEqual(['a'])
    expect(appended.project.tracks.map(track => track.id)).toEqual(['a', 'gone'])
    expect(appended.project.tracks[1].clips[0].id).toBe('take-gone')
  })
})

describe('selectInputChannels (browser recording)', () => {
  const buffer = (channels: number) => {
    const data = Array.from({ length: channels }, (_, index) => new Float32Array([index, index, index]))
    return { numberOfChannels: channels, getChannelData: (index: number) => data[index] }
  }
  it('keeps the chosen channels of the recorded stream', () => {
    expect(selectInputChannels(buffer(2), [1])?.map(channel => [...channel])).toEqual([[1, 1, 1]])
    expect(selectInputChannels(buffer(4), [3, 2])?.map(channel => channel[0])).toEqual([3, 2])
  })
  it('leaves the take alone for the default input, an identical layout, or channels the browser did not deliver', () => {
    expect(selectInputChannels(buffer(2), undefined)).toBeNull()
    expect(selectInputChannels(buffer(1), [0])).toBeNull()
    expect(selectInputChannels(buffer(2), [0, 1])).toBeNull()
    expect(selectInputChannels(buffer(2), [2])).toBeNull()
  })
})
