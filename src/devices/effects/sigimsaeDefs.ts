import type { EffectDef } from '../contracts.js'

/**
 * Parameter catalogs of the sample-processed 시김새 (effects), mirrored by the engine's kernels
 * (rust/garak-dsp). Keep the ids, ranges and defaults identical: saved projects store these numbers.
 */

const ON_OFF = [{ value: 0, label: '끔' }, { value: 1, label: '켬' }] as const

/** Note values in quarter-note beats. Triplets are 2/3 of the straight value. */
export const DELAY_TIME_OPTIONS = [
  { value: 1 / 6, label: '1/16T' }, { value: 0.25, label: '1/16' }, { value: 1 / 3, label: '1/8T' }, { value: 0.375, label: '1/16.' },
  { value: 0.5, label: '1/8' }, { value: 2 / 3, label: '1/4T' }, { value: 0.75, label: '1/8.' }, { value: 1, label: '1/4' },
  { value: 4 / 3, label: '1/2T' }, { value: 1.5, label: '1/4.' }, { value: 2, label: '1/2' }, { value: 3, label: '1/2.' }, { value: 4, label: '1마디' },
] as const

/** Tremolo / auto-pan cycle length in beats; 0 follows the free Hz rate. */
export const LFO_SYNC_OPTIONS = [
  { value: 0, label: '끔' }, { value: 4, label: '1마디' }, { value: 2, label: '1/2' }, { value: 1, label: '1/4' }, { value: 2 / 3, label: '1/4T' },
  { value: 0.5, label: '1/8' }, { value: 1 / 3, label: '1/8T' }, { value: 0.25, label: '1/16' }, { value: 1 / 6, label: '1/16T' },
] as const

export const DELAY_DEF: EffectDef = {
  name: '메아리 Echo', short: '딜레이', label: '딜레이',
  params: [
    { id: 'amount', label: '양', min: 0, max: 1, default: 0.3, unit: 'pct' },
    { id: 'time', label: '박자', min: 1 / 6, max: 4, default: 0.75, unit: 'x', options: DELAY_TIME_OPTIONS },
    { id: 'feedback', label: '피드백', min: 0, max: 0.95, default: 0.32, unit: 'pct' },
    { id: 'tone', label: '하이컷', min: 500, max: 16000, default: 3800, unit: 'hz', scale: 'log' },
    { id: 'lowcut', label: '로우컷', min: 20, max: 2000, default: 20, unit: 'hz', scale: 'log' },
    { id: 'age', label: '테이프', min: 0, max: 1, default: 0, unit: 'pct' },
    { id: 'sync', label: '템포', min: 0, max: 1, default: 1, unit: 'x', options: [{ value: 0, label: 'ms' }, { value: 1, label: '박자' }] },
    { id: 'ms', label: '시간', min: 1, max: 2000, default: 375, unit: 'ms', scale: 'log' },
    { id: 'mode', label: '모드', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: '스테레오' }, { value: 1, label: '핑퐁' }] },
    // Dry (original) level: 1 keeps the insert behaviour; 0 = 100% wet for return tracks (docs/SENDS_RETURNS.md).
    { id: 'dry', label: '원음', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

export const CHORUS_DEF: EffectDef = {
  name: 'Silk Chorus', short: '코러스', label: '코러스',
  params: [
    { id: 'rate', label: '속도', min: 0.05, max: 5, default: 0.8, unit: 'hz', scale: 'log' },
    { id: 'depth', label: '깊이', min: 0, max: 1, default: 0.5, unit: 'pct' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 0.5, unit: 'pct' },
  ],
}

export const PHASER_DEF: EffectDef = {
  name: 'Orbit Phase', short: '페이저', label: '페이저',
  params: [
    { id: 'rate', label: '속도', min: 0.05, max: 5, default: 0.5, unit: 'hz', scale: 'log' },
    { id: 'depth', label: '깊이', min: 0, max: 1, default: 0.7, unit: 'pct' },
    { id: 'feedback', label: '피드백', min: 0, max: 0.9, default: 0.4, unit: 'pct' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

export const FLANGER_DEF: EffectDef = {
  name: 'Jet Flange', short: '플랜저', label: '플랜저',
  params: [
    { id: 'rate', label: '속도', min: 0.05, max: 5, default: 0.25, unit: 'hz', scale: 'log' },
    { id: 'depth', label: '깊이', min: 0, max: 1, default: 0.7, unit: 'pct' },
    { id: 'feedback', label: '피드백', min: 0, max: 0.95, default: 0.6, unit: 'pct' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

export const TREMOLO_DEF: EffectDef = {
  name: '물결 Trem', short: '트레몰로', label: '트레몰로·오토팬',
  params: [
    { id: 'rate', label: '속도', min: 0.1, max: 20, default: 4, unit: 'hz', scale: 'log' },
    { id: 'depth', label: '깊이', min: 0, max: 1, default: 0.5, unit: 'pct' },
    { id: 'shape', label: '모양', min: 0, max: 1, default: 0, unit: 'pct' },
    { id: 'sync', label: '템포', min: 0, max: 4, default: 0, unit: 'x', options: LFO_SYNC_OPTIONS },
    { id: 'pan', label: '모드', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: '트레몰로' }, { value: 1, label: '오토팬' }] },
  ],
}

export const LIMITER_DEF: EffectDef = {
  name: 'Ceiling', short: '리미터', label: '리미터',
  params: [
    { id: 'gain', label: '입력', min: 0, max: 24, default: 0, unit: 'db' },
    { id: 'ceiling', label: '실링', min: -24, max: 0, default: -1, unit: 'db' },
    { id: 'release', label: '릴리즈', min: 10, max: 1000, default: 100, unit: 'ms', scale: 'log' },
  ],
}

export const GATE_DEF: EffectDef = {
  name: 'Hush Gate', short: '게이트', label: '노이즈 게이트',
  params: [
    { id: 'threshold', label: '스레숄드', min: -80, max: 0, default: -50, unit: 'db' },
    { id: 'attack', label: '어택', min: 0.1, max: 50, default: 1, unit: 'ms', scale: 'log' },
    { id: 'hold', label: '홀드', min: 0, max: 500, default: 50, unit: 'ms' },
    { id: 'release', label: '릴리즈', min: 5, max: 2000, default: 150, unit: 'ms', scale: 'log' },
  ],
}

export const TAPE_DEF: EffectDef = {
  name: 'Reel 15', short: '테이프', label: '테이프 새츄레이션',
  params: [
    { id: 'drive', label: '드라이브', min: 0, max: 24, default: 6, unit: 'db' },
    { id: 'warmth', label: '온기', min: 0, max: 1, default: 0.5, unit: 'pct' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
    { id: 'output', label: '출력', min: -24, max: 6, default: 0, unit: 'db' },
  ],
}

export const BITCRUSHER_DEF: EffectDef = {
  name: 'Lo-Fi Crush', short: '크러셔', label: '비트크러셔',
  params: [
    { id: 'bits', label: '비트', min: 1, max: 16, default: 8, unit: 'bits' },
    { id: 'downsample', label: '다운샘플', min: 1, max: 32, default: 4, unit: 'x', scale: 'log' },
    { id: 'mix', label: '믹스', min: 0, max: 1, default: 1, unit: 'pct' },
  ],
}

export const UTILITY_DEF: EffectDef = {
  name: 'Width', short: '유틸리티', label: '유틸리티',
  params: [
    { id: 'gain', label: '게인', min: -36, max: 24, default: 0, unit: 'db' },
    { id: 'pan', label: '팬', min: -1, max: 1, default: 0, unit: 'pan' },
    { id: 'width', label: '폭', min: 0, max: 2, default: 1, unit: 'pct' },
    { id: 'mono', label: '모노', min: 0, max: 1, default: 0, unit: 'x', options: ON_OFF },
    { id: 'phase', label: '위상 반전', min: 0, max: 3, default: 0, unit: 'x', options: [{ value: 0, label: '끔' }, { value: 1, label: '왼쪽' }, { value: 2, label: '오른쪽' }, { value: 3, label: '양쪽' }] },
  ],
}

export const KERNEL_DEFS = {
  delay: DELAY_DEF, chorus: CHORUS_DEF, phaser: PHASER_DEF, flanger: FLANGER_DEF, tremolo: TREMOLO_DEF,
  limiter: LIMITER_DEF, gate: GATE_DEF, tape: TAPE_DEF, bitcrusher: BITCRUSHER_DEF, utility: UTILITY_DEF,
} as const satisfies Record<string, EffectDef>
export type KernelType = keyof typeof KERNEL_DEFS
export const KERNEL_TYPES = Object.keys(KERNEL_DEFS) as KernelType[]
