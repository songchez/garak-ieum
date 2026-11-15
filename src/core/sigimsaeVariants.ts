import type { EffectType } from './types.js'
import { EFFECT_DEFS, EFFECT_TYPES } from '../devices/effects/registry.js'

/**
 * Library variants of the built-in 시김새 (effects): one generic module + a parameter preset +
 * its own display name and a plain use label. Picking one adds the module with those values and
 * the variant name on its header; the user can still rename it and turn every knob.
 * Names are original (Korean-flavoured or playful homages); none is a hardware trademark.
 */
export interface SigimsaeVariant {
  id: string
  effectType: EffectType
  name: string
  /** Plain use / type label ("스튜디오 보컬 리버브"). */
  label: string
  category: SigimsaeCategory
  /** Only the values that differ from the module defaults. */
  params: Record<string, number>
  /** Extra search words (English aliases, uses). */
  aliases?: string
}

export const SIGIMSAE_CATEGORIES = ['EQ·필터', '다이내믹', '드라이브·앰프', '모듈레이션', '공간', '유틸리티'] as const
export type SigimsaeCategory = typeof SIGIMSAE_CATEGORIES[number]

const v = (id: string, effectType: EffectType, name: string, label: string, category: SigimsaeCategory, params: Record<string, number> = {}, aliases = ''): SigimsaeVariant =>
  ({ id, effectType, name, label, category, params, aliases })

export const SIGIMSAE_VARIANTS: readonly SigimsaeVariant[] = [
  // EQ·필터
  v('eq', 'eq', 'Curve 8', '파라메트릭 EQ · 그래프로 조절', 'EQ·필터', {}, 'eq equalizer tone parametric curve'),
  v('eq-vocal-presence', 'eq', '보컬 존재감', '보컬 EQ · 2~3 kHz 앞으로', 'EQ·필터', { low: -2, mid: 3.5, midFreq: 2800, high: 2 }, 'vocal presence eq'),
  v('eq-low-weight', 'eq', '무게감', '저역 보강 EQ', 'EQ·필터', { low: 5, mid: -2, midFreq: 450 }, 'bass weight warm eq'),
  v('eq-air', 'eq', '하늘 Air', '고역 공기감 EQ', 'EQ·필터', { high: 4.5, mid: -1, midFreq: 600 }, 'air bright sparkle eq'),
  v('filter', 'filter', 'Sweep', '로우패스 필터', 'EQ·필터', {}, 'filter lowpass sweep'),
  v('filter-low-cut', 'filter', '저역 정리', '로우컷 · 하이패스 필터', 'EQ·필터', { mode: 1, cutoff: 110, resonance: 0.7 }, 'low cut high pass cleanup rumble'),
  v('filter-radio', 'filter', '라디오 필터', '밴드패스 · 옛 라디오 소리', 'EQ·필터', { mode: 2, cutoff: 1800, resonance: 1.4 }, 'radio band pass lofi'),
  v('filter-telephone', 'filter', '텔레폰', '좁은 밴드패스 · 전화 목소리', 'EQ·필터', { mode: 2, cutoff: 1300, resonance: 3.5 }, 'telephone phone band pass'),
  // 다이내믹
  v('compressor', 'compressor', 'Glue 76', '컴프레서', '다이내믹', {}, 'compressor comp'),
  v('comp-vocal', 'compressor', '보컬 다듬이', '부드러운 옵토 보컬 컴프', '다이내믹', { threshold: -24, ratio: 3, attack: 25, release: 400, makeup: 5 }, 'vocal opto smooth leveling compressor'),
  v('comp-drum-smash', 'compressor', '북채 Drum Smash', '드럼 스매시 컴프', '다이내믹', { threshold: -34, ratio: 20, attack: 0.5, release: 70, makeup: 10 }, 'drum smash crush parallel compressor'),
  v('comp-bus-glue', 'compressor', '버스 Glue', '믹스 버스 컴프', '다이내믹', { threshold: -14, ratio: 2, attack: 30, release: 300, makeup: 2 }, 'mix bus glue master compressor'),
  v('comp-76-punch', 'compressor', '76 Punch', '빠른 FET 스타일 컴프', '다이내믹', { threshold: -20, ratio: 8, attack: 0.3, release: 60, makeup: 6 }, 'fet fast punch compressor'),
  v('comp-peak', 'compressor', '피크 지킴이', '가벼운 피크 제어', '다이내믹', { threshold: -6, ratio: 10, attack: 1, release: 100 }, 'peak control gentle compressor'),
  v('limiter', 'limiter', 'Ceiling', '리미터', '다이내믹', {}, 'limiter brickwall'),
  v('limiter-loud', 'limiter', '마스터 Loud', '마스터 음압 리미터', '다이내믹', { gain: 6, ceiling: -0.3, release: 60 }, 'master loud maximizer limiter'),
  v('limiter-soft', 'limiter', '여유 Guard', '느슨한 안전 리미터', '다이내믹', { ceiling: -3, release: 300 }, 'safety soft limiter'),
  v('gate', 'gate', 'Hush Gate', '노이즈 게이트', '다이내믹', {}, 'noise gate'),
  v('gate-kick', 'gate', '킥 Tight', '드럼 타이트 게이트', '다이내믹', { threshold: -30, attack: 0.1, hold: 10, release: 40 }, 'kick drum tight gate'),
  v('gate-vocal', 'gate', '숨소리 정리', '보컬 잡음 게이트', '다이내믹', { threshold: -45, attack: 2, hold: 80, release: 250 }, 'vocal breath noise gate'),
  // 드라이브·앰프
  v('drive', 'drive', 'Hot Tube', '진공관 드라이브', '드라이브·앰프', {}, 'drive overdrive tube'),
  v('drive-crunch', 'drive', '크런치', '크런치 오버드라이브', '드라이브·앰프', { drive: 20, tone: 5500, output: -4 }, 'crunch overdrive'),
  v('drive-fuzz', 'drive', '퍼즈', '퍼즈 · 꽉 찬 왜곡', '드라이브·앰프', { drive: 36, tone: 3000, output: -8 }, 'fuzz distortion'),
  v('drive-edge', 'drive', '살짝 Edge', '은은한 배음 · 병렬', '드라이브·앰프', { drive: 5, tone: 12000, mix: 0.5 }, 'saturation subtle parallel harmonic'),
  v('tape', 'tape', 'Reel 15', '테이프 새츄레이션', '드라이브·앰프', {}, 'tape saturation'),
  v('tape-warm', 'tape', '따뜻한 테이프', '따뜻한 테이프 · 마스터용', '드라이브·앰프', { drive: 10, warmth: 0.8, output: -2 }, 'warm tape master'),
  v('tape-cassette', 'tape', '카세트 Lo', '낡은 카세트', '드라이브·앰프', { drive: 18, warmth: 1, output: -6 }, 'cassette lofi tape'),
  v('bitcrusher', 'bitcrusher', 'Lo-Fi Crush', '비트크러셔', '드라이브·앰프', {}, 'bitcrusher lofi'),
  v('crush-arcade', 'bitcrusher', '오락실 8-Bit', '칩튠 · 8비트 게임기', '드라이브·앰프', { bits: 5, downsample: 8 }, 'chiptune 8bit arcade game'),
  v('crush-grit', 'bitcrusher', '모래 Grit', '은은한 디지털 거칠음', '드라이브·앰프', { bits: 12, downsample: 2, mix: 0.5 }, 'grit digital dirt'),
  v('guitar-rig', 'guitar-rig', '기타 앰프', '앰프 · 캐비닛 · 페달', '드라이브·앰프', {}, 'guitar amp cabinet pedal rig'),
  // 모듈레이션
  v('chorus', 'chorus', 'Silk Chorus', '코러스', '모듈레이션', {}, 'chorus'),
  v('chorus-ensemble', 'chorus', '넓은 합창', '넓은 앙상블 코러스', '모듈레이션', { rate: 0.3, depth: 0.9 }, 'ensemble wide chorus pad strings'),
  v('chorus-vibrato', 'chorus', '떨림 Vibrato', '피치 비브라토', '모듈레이션', { rate: 5, depth: 0.3, mix: 1 }, 'vibrato pitch'),
  v('phaser', 'phaser', 'Orbit Phase', '페이저', '모듈레이션', {}, 'phaser'),
  v('phaser-swirl', 'phaser', '소용돌이', '느리고 깊은 페이저', '모듈레이션', { rate: 0.1, depth: 1, feedback: 0.7 }, 'slow swirl deep phaser'),
  v('phaser-funk', 'phaser', '펑크 Phase', '빠른 펑크 기타 페이저', '모듈레이션', { rate: 2.5, depth: 0.5, feedback: 0.2 }, 'funk fast phaser guitar'),
  v('flanger', 'flanger', 'Jet Flange', '플랜저', '모듈레이션', {}, 'flanger jet'),
  v('flanger-metal', 'flanger', '쇳소리 Comb', '금속성 레조넌트 플랜저', '모듈레이션', { rate: 0.1, depth: 0.3, feedback: 0.9 }, 'metallic resonant comb flanger'),
  v('flanger-subtle', 'flanger', '잔물결', '은은한 플랜저', '모듈레이션', { rate: 0.5, depth: 0.4, feedback: 0.2, mix: 0.5 }, 'subtle gentle flanger'),
  v('tremolo', 'tremolo', '물결 Trem', '트레몰로', '모듈레이션', {}, 'tremolo'),
  v('tremolo-autopan', 'tremolo', '오토팬', '좌우로 흐르는 오토팬', '모듈레이션', { pan: 1, sync: 2, depth: 0.8 }, 'auto pan autopan stereo'),
  v('tremolo-chop', 'tremolo', '헬리콥터 Chop', '16분 게이트 트레몰로', '모듈레이션', { sync: 0.25, depth: 1, shape: 1 }, 'chop helicopter gate stutter tremolo'),
  // 공간
  v('delay', 'delay', '메아리 Echo', '스테레오 딜레이', '공간', {}, 'delay echo stereo'),
  v('delay-mountain', 'delay', '산울림', '긴 산 메아리 · 어두운 반복', '공간', { time: 2, feedback: 0.55, tone: 1800, lowcut: 200, age: 0.15 }, 'long mountain echo dark delay'),
  v('delay-pingpong', 'delay', '여울 Ping-Pong', '핑퐁 딜레이', '공간', { mode: 1, time: 0.5, feedback: 0.45, tone: 6000, lowcut: 150 }, 'ping pong stereo delay'),
  v('delay-slap', 'delay', '슬랩 50', '슬랩백 · 50년대 로커빌리', '공간', { sync: 0, ms: 80, feedback: 0, amount: 0.4, tone: 5000 }, 'slapback slap rockabilly delay'),
  v('delay-dotted', 'delay', '점팔분 Dotted 8th', '점8분 리듬 딜레이', '공간', { time: 0.75, feedback: 0.4, tone: 5000, lowcut: 120 }, 'dotted eighth rhythmic delay'),
  v('delay-tape', 'delay', '릴 Echo', '테이프 에코 · 와우/플러터', '공간', { sync: 0, ms: 330, feedback: 0.45, tone: 3000, lowcut: 120, age: 0.6, amount: 0.32 }, 'tape echo wow flutter delay'),
  v('delay-bucket', 'delay', '버킷 Analog', '어둡고 출렁이는 아날로그(BBD)', '공간', { time: 0.5, feedback: 0.5, tone: 1600, lowcut: 100, age: 0.3 }, 'analog bbd bucket brigade dark delay'),
  v('delay-digital', 'delay', '수정 Digital', '깨끗한 디지털 딜레이', '공간', { time: 1, feedback: 0.35, tone: 16000, amount: 0.28 }, 'clean digital crystal delay'),
  v('delay-lofi', 'delay', '먼지 Lo-fi Echo', '낡고 좁은 로파이 에코', '공간', { time: 0.75, feedback: 0.5, tone: 1200, lowcut: 600, age: 1, amount: 0.35 }, 'lofi dusty echo delay'),
  v('reverb-booth', 'reverb', '보컬 부스', '스튜디오 보컬 리버브', '공간', { type: 1, size: 0.15, tone: 12000, predelay: 20, amount: 0.22, lowcut: 200 }, 'vocal booth studio short reverb'),
  v('reverb-room', 'reverb', '사랑방', '작은 방 리버브', '공간', { type: 1, size: 0.6, tone: 7000, predelay: 8, amount: 0.3 }, 'small room reverb'),
  v('reverb-plate', 'reverb', '마루 Plate', '보컬 플레이트', '공간', { type: 2, size: 0.45, tone: 11000, predelay: 25, lowcut: 150, amount: 0.3 }, 'vocal plate reverb'),
  v('reverb-spring', 'reverb', '스프링 탱크', '스프링 리버브 · 기타', '공간', { type: 3, size: 0.5, tone: 4500, lowcut: 200, amount: 0.35 }, 'spring tank guitar reverb'),
  v('reverb', 'reverb', '대청 Hall', '중간 홀 리버브', '공간', {}, 'hall medium reverb'),
  v('reverb-temple', 'reverb', '대웅전', '큰 홀 · 성당 같은 긴 잔향', '공간', { size: 0.9, tone: 5000, predelay: 40, amount: 0.4 }, 'large hall cathedral long reverb'),
  v('reverb-cave', 'reverb', '동굴', '어둡고 아주 긴 동굴', '공간', { size: 1, tone: 1800, predelay: 60, amount: 0.45 }, 'cave dark huge reverb'),
  v('reverb-ambience', 'reverb', '산사 Ambience', '은은한 공간감 · 믹스 접착', '공간', { type: 1, size: 0.3, amount: 0.12, lowcut: 300 }, 'ambience subtle glue reverb'),
  // 유틸리티
  v('utility', 'utility', 'Width', '유틸리티 · 게인/팬/폭', '유틸리티', {}, 'utility gain pan width'),
  v('utility-wide', 'utility', '넓게 펼치기', '스테레오 폭 넓히기', '유틸리티', { width: 1.6 }, 'stereo widen wide'),
  v('utility-mono', 'utility', '모노 체크', '모노 합산 확인', '유틸리티', { mono: 1 }, 'mono check sum'),
  v('utility-phase', 'utility', '위상 뒤집기', '양쪽 위상 반전', '유틸리티', { phase: 3 }, 'phase invert polarity'),
]

const BY_ID = new Map(SIGIMSAE_VARIANTS.map(variant => [variant.id, variant]))
export const sigimsaeVariant = (id: string | undefined): SigimsaeVariant | undefined => id ? BY_ID.get(id) : undefined

/** The variant whose id is the module id itself: the module's default settings and name. */
export const defaultVariant = (type: EffectType): SigimsaeVariant => BY_ID.get(type)!

export const variantsIn = (category: SigimsaeCategory): SigimsaeVariant[] => SIGIMSAE_VARIANTS.filter(variant => variant.category === category)

/** Search over name, use label, module name/label and aliases (case-insensitive). */
export function searchVariants(query: string): SigimsaeVariant[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...SIGIMSAE_VARIANTS]
  return SIGIMSAE_VARIANTS.filter(variant => {
    const def = EFFECT_DEFS[variant.effectType]
    return [variant.name, variant.label, variant.aliases, def.label, def.short, variant.effectType, variant.category].join(' ').toLowerCase().includes(q)
  })
}

/** Library order check: every module has a default variant. */
export const MODULES_WITHOUT_DEFAULT = EFFECT_TYPES.filter(type => !BY_ID.has(type))

