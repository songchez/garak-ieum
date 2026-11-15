import { describe, expect, it } from 'vitest'
import { MidiCaptureBuffer, capturePerformance, type CaptureEvent } from './midiCapture'

const ev = (type: 'on' | 'off', pitch: number, time: number, beat: number | null = null, source = 'k', channel = 1): CaptureEvent =>
  ({ source, data: type === 'on' ? [0x90 | (channel - 1), pitch, 100] : [0x80 | (channel - 1), pitch, 0], time, beat })

describe('MidiCaptureBuffer', () => {
  it('keeps a rolling window and an event cap, ignoring non-channel messages', () => {
    const buffer = new MidiCaptureBuffer(1000, 3)
    buffer.push(ev('on', 60, 0)); buffer.push({ source: 'k', data: [0xF8], time: 1, beat: null })
    buffer.push(ev('off', 60, 100)); buffer.push(ev('on', 62, 1500))
    expect(buffer.snapshot().map(e => e.time)).toEqual([1500])
    buffer.push(ev('off', 62, 1501)); buffer.push(ev('on', 63, 1502)); buffer.push(ev('off', 63, 1503))
    expect(buffer.size).toBe(3)
  })
})

describe('capturePerformance', () => {
  it('returns null without notes', () => {
    expect(capturePerformance([], { bpm: 120, playheadBeat: 0 })).toBeNull()
  })
  it('stopped transport: converts time at the project tempo and starts at the playhead', () => {
    const events = [ev('on', 60, 1000), ev('off', 60, 1500), ev('on', 62, 2000), ev('off', 62, 2250)]
    const result = capturePerformance(events, { bpm: 120, playheadBeat: 8 })!
    expect(result.playing).toBe(false)
    expect(result.notes).toEqual([{ pitch: 60, start: 8, end: 9, velocity: 100 / 127 }, { pitch: 62, start: 10, end: 10.5, velocity: 100 / 127 }])
  })
  it('only the last performance after a silent gap with nothing held', () => {
    const events = [ev('on', 50, 0), ev('off', 50, 100), ev('on', 60, 10_000), ev('off', 60, 10_500)]
    expect(capturePerformance(events, { bpm: 120, playheadBeat: 0, gapMs: 4000 })!.notes.map(n => n.pitch)).toEqual([60])
    // A note held across the gap keeps the phrase together.
    const held = [ev('on', 50, 0), ev('on', 60, 10_000), ev('off', 50, 10_100), ev('off', 60, 10_500)]
    expect(capturePerformance(held, { bpm: 120, playheadBeat: 0, gapMs: 4000 })!.notes.map(n => n.pitch)).toEqual([50, 60])
  })
  it('running transport: keeps the played beats', () => {
    const events = [ev('on', 60, 0, 4.5), ev('off', 60, 250, 5)]
    const result = capturePerformance(events, { bpm: 120, playheadBeat: 0 })!
    expect(result.playing).toBe(true)
    expect(result.notes).toEqual([{ pitch: 60, start: 4.5, end: 5, velocity: 100 / 127 }])
  })
  it('over a running cycle only the last pass is captured', () => {
    const events = [ev('on', 60, 0, 1), ev('off', 60, 100, 1.2), ev('on', 62, 2000, 0.5), ev('off', 62, 2100, 0.7)]
    expect(capturePerformance(events, { bpm: 120, playheadBeat: 0 })!.notes.map(n => n.pitch)).toEqual([62])
  })
  it('filters by the target track input', () => {
    const events = [ev('on', 60, 0, null, 'a'), ev('off', 60, 10, null, 'a'), ev('on', 36, 20, null, 'pad'), ev('off', 36, 30, null, 'pad')]
    expect(capturePerformance(events, { bpm: 120, playheadBeat: 0, accepts: source => source === 'pad' })!.notes.map(n => n.pitch)).toEqual([36])
  })
  it('closes notes still held at the end with the last event', () => {
    const events = [ev('on', 60, 0), ev('on', 64, 500), ev('off', 64, 1000)]
    expect(capturePerformance(events, { bpm: 120, playheadBeat: 0 })!.notes).toEqual([{ pitch: 60, start: 0, end: 2, velocity: 100 / 127 }, { pitch: 64, start: 1, end: 2, velocity: 100 / 127 }])
  })
})
