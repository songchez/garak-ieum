import { describe, expect, it } from 'vitest'
import { VIBRATO_CENTS, applyControl, chaseControls, controllerGain, type TrackControls } from './graph'

class Param {
  value = 0
  readonly calls: [number, number][] = []
  setTargetAtTime(value: number, time: number) { this.calls.push([value, time]); this.value = value; return this }
}
const fakeControls = () => {
  const bend = new Param(), depth = new Param(), gain = new Param()
  const controls = {
    input: { gain }, pitch: {}, bend: { offset: bend }, vibrato: {}, vibratoDepth: { gain: depth },
    state: { bend: 0, mod: 0, aftertouch: 0, volume: 100, expression: 127 },
  } as unknown as TrackControls
  return { controls, bend, depth, gain }
}

describe('Web Audio controller response (docs/MIDI_CONTROLLERS.md)', () => {
  it('maps pitch bend to cents with the region range, mod/aftertouch to vibrato depth and CC7/CC11 to gain', () => {
    const { controls, bend, depth, gain } = fakeControls()
    applyControl(controls, 'pitchBend', 8192 / 2, 1, 12)
    expect(bend.calls.at(-1)).toEqual([600, 1])
    applyControl(controls, 'pitchBend', -8192, 2)
    expect(bend.calls.at(-1)).toEqual([-200, 2])
    applyControl(controls, 'cc1', 127, 3)
    expect(depth.calls.at(-1)).toEqual([VIBRATO_CENTS, 3])
    applyControl(controls, 'aftertouch', 0, 3)
    expect(depth.value).toBe(VIBRATO_CENTS) // the larger of mod wheel and aftertouch
    applyControl(controls, 'cc11', 64, 4)
    expect(gain.value).toBeCloseTo((64 / 127) ** 2)
    applyControl(controls, 'cc7', 50, 4)
    expect(gain.value).toBeCloseTo(controllerGain(50, 64))
    expect(controllerGain(100, 127)).toBe(1)
    applyControl(controls, 'cc10', 0, 5) // pan has no built-in meaning
    expect(gain.calls).toHaveLength(2)
  })

  it('chases the values in effect at a position and defaults the rest', () => {
    const { controls, bend, depth, gain } = fakeControls()
    controls.state.mod = 90
    chaseControls(controls, [{ beat: 0, key: 'pitchBend', value: 4096, range: 2 }, { beat: 1, key: 'cc11', value: 0 }, { beat: 3, key: 'pitchBend', value: 0, range: 2, reset: true }], 2, 9)
    expect(bend.value).toBe(100)
    expect(depth.value).toBe(0)
    expect(gain.value).toBe(0)
    expect(bend.calls[0][1]).toBe(9)
  })
})
