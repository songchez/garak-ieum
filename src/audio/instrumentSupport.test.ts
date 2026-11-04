import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createTrack } from '../core/project'
import { WebAudioEngine } from './WebAudioEngine'
import { canPlayInstrument, unsupportedWebAudioInstruments } from './instrumentSupport'

function fixture() {
  const track = createTrack('instrument', 'wavetable')
  track.clips = [{ id: 'phrase', kind: 'midi', name: 'Phrase', startBeat: 0, lengthBeats: 4, gain: 1, notes: [{ id: 'note', start: 0, duration: 1, pitch: 60, velocity: 0.8 }] }]
  return { ...createEmptyProject(), tracks: [track] }
}

afterEach(() => vi.unstubAllGlobals())

describe('native instrument availability', () => {
  it('rejects preview, transport and WAV export before opening any browser audio device', async () => {
    const audio = vi.fn(), offline = vi.fn()
    vi.stubGlobal('AudioContext', audio)
    vi.stubGlobal('OfflineAudioContext', offline)
    const engine = new WebAudioEngine(fixture())
    expect(canPlayInstrument(engine, 'wavetable')).toBe(false)
    expect(canPlayInstrument(engine, 'keys')).toBe(true)
    await expect(engine.previewNote('wavetable', 60)).rejects.toThrow(/네이티브/)
    await expect(engine.play()).rejects.toThrow(/네이티브/)
    await expect(engine.exportWav()).rejects.toThrow(/네이티브/)
    expect(audio).not.toHaveBeenCalled()
    expect(offline).not.toHaveBeenCalled()
    expect(engine.getSnapshot().playing).toBe(false)
    engine.dispose()
  })

  it('lets empty, muted, disabled or excluded tracks coexist with browser instruments', () => {
    const project = fixture()
    expect(unsupportedWebAudioInstruments(project)).toEqual(['IEUM WAVE'])
    for (const patch of [{ mute: true }, { enabled: false }, { volume: 0 }, { clips: [] }]) {
      expect(unsupportedWebAudioInstruments({ ...project, tracks: [{ ...project.tracks[0], ...patch }] })).toEqual([])
    }
    expect(unsupportedWebAudioInstruments({ ...project, tracks: [...project.tracks, { ...createTrack('instrument', 'keys'), solo: true }] })).toEqual([])
  })

  it('uses the visible playback window and note limits, including delayed repetitions and velocity offsets', () => {
    const project = fixture()
    const track = project.tracks[0], clip = track.clips[0]
    if (clip.kind !== 'midi') throw new Error('MIDI fixture expected')
    const checked = (patch: Partial<typeof track>) => unsupportedWebAudioInstruments({ ...project, tracks: [{ ...track, ...patch }] })
    expect(checked({ clips: [{ ...clip, sourceOffsetBeats: 2 }] })).toEqual([])
    expect(checked({ keyLimit: [72, 127] })).toEqual([])
    expect(checked({ clips: [{ ...clip, startBeat: project.lengthBeats }] })).toEqual([])
    expect(checked({ delayTicks: -1920, clips: [{ ...clip, lengthBeats: 1 }] })).toEqual([])
    expect(checked({ delayTicks: -1920, clips: [{ ...clip, lengthBeats: 1, loop: true, loopLengthBeats: 4 }] })).toEqual(['IEUM WAVE'])
    expect(checked({ velocityOffset: 20, clips: [{ ...clip, notes: [{ ...clip.notes[0], velocity: 0 }] }] })).toEqual(['IEUM WAVE'])
    expect(unsupportedWebAudioInstruments({ ...project, masterVolume: 0 })).toEqual([])
  })
})
