import { WAVE_FACTORY_BANKS, WAVE_LIMITS } from '../definition'
import { getFactoryWavetableFrames } from '../model'
import type { WavetablePatch } from '../model'

const factories = new Map<number, number[][]>()
export function factoryFrames(index: number) {
  let frames = factories.get(index)
  if (!frames) { frames = getFactoryWavetableFrames(index); factories.set(index, frames) }
  return frames
}
export function bankFrames(patch: WavetablePatch, index: number): readonly (readonly number[])[] {
  return index < WAVE_LIMITS.factoryBanks ? factoryFrames(index) : patch.customBanks.find(bank => bank.slot === index)?.frames ?? []
}
export function bankName(patch: WavetablePatch, index: number) {
  return index < WAVE_LIMITS.factoryBanks ? WAVE_FACTORY_BANKS[index].name : patch.customBanks.find(bank => bank.slot === index)?.name ?? '빈 사용자 뱅크'
}
export function interpolateFrame(frames: readonly (readonly number[])[], position: number): number[] {
  if (!frames.length) return []
  const point = Math.max(0, Math.min(1, position)) * (frames.length - 1)
  const lower = Math.floor(point), upper = Math.min(frames.length - 1, lower + 1), mix = point - lower
  return frames[lower].map((value, index) => value + (frames[upper][index] - value) * mix)
}
export type DrawShape = 'sine' | 'triangle' | 'saw' | 'square'
export function shapeSamples(shape: DrawShape, length: number, bipolar = false): number[] {
  return Array.from({ length }, (_, index) => {
    const phase = index / length
    const value = shape === 'sine' ? (1 - Math.cos(phase * Math.PI * 2)) / 2 : shape === 'triangle' ? 1 - Math.abs(phase * 2 - 1) : shape === 'saw' ? phase : phase < .5 ? 1 : 0
    return bipolar ? value * 2 - 1 : value
  })
}
export const SHAPES: readonly { id: DrawShape; label: string; symbol: string }[] = [
  { id: 'sine', label: '사인', symbol: '∿' }, { id: 'triangle', label: '삼각', symbol: '△' },
  { id: 'saw', label: '상승', symbol: '↗' }, { id: 'square', label: '사각', symbol: '⊓' },
]
