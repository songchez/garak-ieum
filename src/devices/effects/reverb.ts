import type { EffectDef, EffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader } from './shared.js'

/**
 * Space types. Each has a short and a long decaying-noise impulse; Size blends them. The impulse
 * shapes are mirrored by native/src/dsp.cpp impulse(): keep seconds, seeds and formulas identical.
 * 0 홀: smooth (1-t)^3.6 · 1 룸: short, fast (1-t)^4.5 · 2 플레이트: pre-emphasised (bright, dense)
 * noise, (1-t)^2.4 · 3 스프링: dark noise through a 29.3 ms feedback comb (the "drip").
 */
export const REVERB_SPACES = [
  { short: { seconds: 1.7, seed: 9183 }, long: { seconds: 4.2, seed: 61427 } },
  { short: { seconds: 0.35, seed: 4421 }, long: { seconds: 1.2, seed: 7717 } },
  { short: { seconds: 1.1, seed: 3301 }, long: { seconds: 3.2, seed: 8803 } },
  { short: { seconds: 0.9, seed: 5153 }, long: { seconds: 2.6, seed: 6007 } },
] as const

const definition: EffectDef = {
  name: '대청 Hall', short: '리버브', label: '리버브',
  params: [
    { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
    { id: 'size', label: '크기', min: 0, max: 1, default: 0.35, unit: 'pct' },
    { id: 'tone', label: '톤', min: 1000, max: 20000, default: 9000, unit: 'hz', scale: 'log' },
    { id: 'type', label: '공간', min: 0, max: 3, default: 0, unit: 'x', options: [{ value: 0, label: '홀' }, { value: 1, label: '룸' }, { value: 2, label: '플레이트' }, { value: 3, label: '스프링' }] },
    { id: 'predelay', label: '프리딜레이', min: 0, max: 250, default: 0, unit: 'ms' },
    { id: 'lowcut', label: '로우컷', min: 20, max: 1000, default: 20, unit: 'hz', scale: 'log' },
    // Dry (original) level: 1 keeps the insert behaviour; 0 = 100% wet for return tracks (docs/SENDS_RETURNS.md).
    { id: 'dry', label: '원음', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

const spaceOf = (value: number) => clamp(Math.round(value), 0, REVERB_SPACES.length - 1)

export const reverbEffect: EffectModule = {
  id: 'reverb', stateVersion: 1, definition,
  tailSeconds(params) {
    const p = parameterReader(definition.params, params)
    if (p('amount') <= 0) return 0
    const { short, long } = REVERB_SPACES[spaceOf(p('type'))]
    return 0.85 + short.seconds + clamp(p('size'), 0, 1) * (long.seconds - short.seconds) + p('predelay') / 1000
  },
}
