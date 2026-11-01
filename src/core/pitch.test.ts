import { describe, expect, it } from 'vitest'
import { parsePitchName, pitchClassName, pitchName } from './pitch'

describe('shared pitch display', () => {
  it('uses C3 for middle C throughout the MIDI range', () => {
    expect(pitchName(0)).toBe('C-2')
    expect(pitchName(12)).toBe('C-1')
    expect(pitchName(59)).toBe('B2')
    expect(pitchName(60)).toBe('C3')
    expect(pitchName(61)).toBe('C♯3')
    expect(pitchName(69)).toBe('A3')
    expect(pitchName(72)).toBe('C4')
    expect(pitchName(127)).toBe('G8')
  })

  it('round-trips all 128 displayed notes without changing their MIDI pitches', () => {
    for (let midi = 0; midi <= 127; midi++) {
      expect(parsePitchName(pitchName(midi))).toBe(midi)
    }
  })

  it('uses the same pitch-class spelling on compact piano keys', () => {
    expect(pitchClassName(60)).toBe('C')
    expect(pitchClassName(61)).toBe('C♯')
    expect(pitchClassName(70)).toBe('A♯')
  })
})

describe('pitch input', () => {
  it('accepts ASCII and musical accidentals, case and whitespace', () => {
    for (const label of ['C#3', 'C♯3', 'Db3', 'D♭3', ' d b 3 ']) {
      expect(parsePitchName(label)).toBe(61)
    }
    expect(parsePitchName('c-2')).toBe(0)
    expect(parsePitchName('G8')).toBe(127)
  })

  it('handles enharmonic spellings across an octave boundary', () => {
    expect(parsePitchName('B#2')).toBe(60)
    expect(parsePitchName('Cb3')).toBe(59)
    expect(parsePitchName('E#3')).toBe(65)
    expect(parsePitchName('Fb3')).toBe(64)
  })

  it('preserves numeric input and leaves clamping to the inspector field', () => {
    expect(parsePitchName('60')).toBe(60)
    expect(parsePitchName(' 127 ')).toBe(127)
    expect(parsePitchName('C9')).toBe(132)
    expect(parsePitchName('C-3')).toBe(-12)
  })

  it('rejects unrecognized note names and nonfinite numbers', () => {
    for (const label of ['H3', 'C', 'C#', 'C3x', 'NaN', 'Infinity']) {
      expect(parsePitchName(label)).toBeNull()
    }
  })
})
