import { describe, expect, it } from 'vitest'
import { dynamicsReadingFrom } from './dynamicsMeter'

// The readings themselves come from the engine (rust/garak-engine `take_dynamics`; the web worklet's meter
// block is covered by src/audio/rust/webHost.test.ts and engineChannel.test.ts).
describe('dynamics meter plumbing', () => {
  it('validates native IPC readings', () => {
    expect(dynamicsReadingFrom({ input: 0.5, gain: 0.25 })).toEqual({ input: 0.5, gain: 0.25 })
    expect(dynamicsReadingFrom({ input: 2, gain: 3 })).toEqual({ input: 2, gain: 1 })
    expect(dynamicsReadingFrom({ input: 'x', gain: 1 })).toBeNull()
    expect(dynamicsReadingFrom({ input: Number.NaN, gain: 1 })).toBeNull()
    expect(dynamicsReadingFrom(null)).toBeNull()
  })
})
