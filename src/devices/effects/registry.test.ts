import { describe, expect, it } from 'vitest'
import { COMMAND_METADATA } from '../../core/commands'
import { defaultParams } from '../../core/devices'
import { createDevice, createEmptyProject, createTrack, validateProject } from '../../core/project'
import type { Device, Project } from '../../core/types'
import { renderTailSeconds } from '../../audio/renderTail'
import { EFFECT_DEFS, EFFECT_MODULES, EFFECT_TYPES } from './registry'

function audioProject(devices: Device[]): Project {
  return { ...createEmptyProject(), bpm: 120, tracks: [{ ...createTrack('audio'), id: 'audio', devices }] }
}

describe('built-in effect modules share one catalog', () => {
  it('retains saved IDs, ordering, and original numeric defaults in UI and MCP', () => {
    expect(EFFECT_TYPES).toEqual(['eq', 'filter', 'compressor', 'drive', 'delay', 'reverb', 'guitar-rig', 'chorus', 'phaser', 'flanger', 'tremolo', 'limiter', 'gate', 'tape', 'bitcrusher', 'utility'])
    expect(Object.fromEntries(EFFECT_TYPES.filter(type => type !== 'guitar-rig').map(type => [type, defaultParams(EFFECT_DEFS[type].params)]))).toEqual({
      // The original 3-band ids stay first and keep their defaults; bands 4–8 start off.
      eq: expect.objectContaining({ low: 0, mid: 0, midFreq: 1000, high: 0, b1On: 1, b1Type: 1, b1Freq: 220, b2Q: 0.9, b3Freq: 4500, b4On: 0, output: 0 }),
      filter: { cutoff: 1200, resonance: 0.7, mode: 0, slope: 0 },
      compressor: { threshold: -18, ratio: 4, attack: 10, release: 150, makeup: 0 },
      drive: { drive: 9, tone: 9000, mix: 1, output: 0 },
      delay: { amount: 0.3, time: 0.75, feedback: 0.32, tone: 3800, lowcut: 20, age: 0, sync: 1, ms: 375, mode: 0, dry: 1 },
      reverb: { amount: 0.3, size: 0.35, tone: 9000, type: 0, predelay: 0, lowcut: 20, dry: 1 },
      chorus: { rate: 0.8, depth: 0.5, mix: 0.5 },
      phaser: { rate: 0.5, depth: 0.7, feedback: 0.4, mix: 1 },
      flanger: { rate: 0.25, depth: 0.7, feedback: 0.6, mix: 1 },
      tremolo: { rate: 4, depth: 0.5, shape: 0, sync: 0, pan: 0 },
      limiter: { gain: 0, ceiling: -1, release: 100 },
      gate: { threshold: -50, attack: 1, hold: 50, release: 150 },
      tape: { drive: 6, warmth: 0.5, mix: 1, output: 0 },
      bitcrusher: { bits: 8, downsample: 4, mix: 1 },
      utility: { gain: 0, pan: 0, width: 1, mono: 0, phase: 0 },
    })
    const command = COMMAND_METADATA.find(command => command.type === 'effect.add')!
    const schema = command.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(schema.effectType.enum).toBe(EFFECT_TYPES)
    for (const type of EFFECT_TYPES) {
      expect(EFFECT_MODULES[type].id).toBe(type)
      expect(EFFECT_MODULES[type].definition).toBe(EFFECT_DEFS[type])
    }
  })

  it('round-trips existing numeric device state and bypass through project validation', () => {
    const devices = EFFECT_TYPES.map(type => createDevice(type))
    devices[0] = { ...devices[0], enabled: false, params: { ...devices[0].params, mid: -5.5 } }
    const project = audioProject(devices)
    const restored = validateProject(JSON.parse(JSON.stringify(project)))
    expect(restored.tracks[0].devices).toEqual(devices)
  })
})

describe('export tails of effect modules', () => {
  it('uses module tail estimates with tempo, bypass, and disabled-track guards', () => {
    const delay = createDevice('delay', { time: 1, feedback: 0.5, amount: 1 })
    const project = audioProject([delay])
    expect(renderTailSeconds(project)).toBeCloseTo(6.35)
    expect(renderTailSeconds({ ...project, bpm: 60 })).toBeCloseTo(11.85)
    expect(renderTailSeconds(audioProject([{ ...delay, enabled: false }]))).toBe(0.85)
    expect(renderTailSeconds({ ...project, tracks: [{ ...project.tracks[0], enabled: false }] })).toBe(0.85)
    expect(renderTailSeconds(audioProject([createDevice('reverb', { amount: 1, size: 1 })]))).toBeCloseTo(5.05)
    expect(renderTailSeconds(audioProject([createDevice('reverb', { amount: 0 })]))).toBe(0.85)
  })

  it('includes return tails after their senders (docs/SENDS_RETURNS.md)', () => {
    const ret = { ...createTrack('return'), id: 'ret', soloSafe: true, devices: [createDevice('reverb', { amount: 1, dry: 0 })] }
    const keys = { ...createTrack('instrument'), id: 'keys', sends: [{ returnId: 'ret', level: 0.5 }] }
    const project = { ...createEmptyProject(), tracks: [ret, keys] }
    const reverbTail = EFFECT_MODULES.reverb.tailSeconds({ amount: 1, dry: 0, size: 0.35, tone: 9000, type: 0, predelay: 0, lowcut: 20 }, 120)
    // keys (release 0.3 s + 0.2) feeds the return, so the reverb rings on after the keys' own release.
    expect(renderTailSeconds(project)).toBeCloseTo(reverbTail + 0.5, 6)
  })
})
