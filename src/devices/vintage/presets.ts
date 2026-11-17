import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_PARAMS, type VintageInstrumentId } from './params'

/** A factory sound: overrides on top of the catalog defaults (every other parameter is reset). */
export interface VintagePreset { id: string; name: string; description: string; params: Readonly<Record<string, number>> }

export const VINTAGE_PRESETS: Readonly<Record<VintageInstrumentId, readonly VintagePreset[]>> = {
  [OKGU_EP_ID]: [
    { id: 'clear', name: '맑은', description: '유리알 같은 벨, 가벼운 바크', params: { tone: 0.3, bark: 0.2, bell: 0.65, pickup: 0.25, hammer: 0.35 } },
    { id: 'warm', name: '따뜻한', description: '둥글고 길게 남는 톤바', params: { tone: -0.5, bark: 0.3, bell: 0.3, pickup: 0.4, hammer: 0.25, decay: 1.3, release: 0.18 } },
    { id: 'bark', name: '거친 Bark', description: '세게 칠수록 으르렁대는 픽업', params: { tone: 0.15, bark: 1, pickup: 0.75, bell: 0.55, hammer: 0.55, dynamics: 0.85, drive: 0.35 } },
    { id: 'tremolo-70s', name: '70s 트레몰로', description: '좌우로 흐르는 스테레오 오토팬', params: { tone: -0.1, bark: 0.5, pickup: 0.45, tremRate: 5.2, tremDepth: 0.55, autopan: 1 } },
    { id: 'stage', name: '무대 드라이브', description: '앰프를 밀어붙인 라이브 톤', params: { tone: 0.2, bark: 0.7, drive: 0.7, tremRate: 3.5, tremDepth: 0.2 } },
    { id: 'dawn', name: '새벽 발라드', description: '부드러운 터치와 느린 흔들림', params: { tone: -0.3, bark: 0.15, bell: 0.45, decay: 1.6, release: 0.3, dynamics: 0.55, tremRate: 2.8, tremDepth: 0.25, autopan: 0.6 } },
  ],
  [HANBAM_106_ID]: [
    { id: 'pad', name: '한밤 패드', description: 'PWM과 코러스 II로 넓게 퍼지는 패드', params: { saw: 1, pulse: 0.5, pwm: 0.5, pwmSource: 1, sub: 0.2, cutoff: 1800, resonance: 0.15, envAmount: 0.15, attack: 0.6, decay: 1.5, sustain: 0.8, release: 1.6, lfoRate: 0.6, chorus: 2 } },
    { id: 'brass', name: '브라스', description: '엔벨로프로 열리는 필터 브라스', params: { saw: 1, sub: 0.3, cutoff: 700, resonance: 0.2, envAmount: 0.55, attack: 0.06, decay: 0.5, sustain: 0.65, release: 0.25, velocity: 0.5, chorus: 1 } },
    { id: 'bass', name: '베이스', description: '16피트 모노, 서브가 받쳐 주는 베이스', params: { range: 0, saw: 0.8, pulse: 0.6, pwm: 0.2, pwmSource: 0, sub: 0.9, hpf: 0, cutoff: 420, resonance: 0.35, envAmount: 0.45, decay: 0.35, sustain: 0.4, release: 0.08, glide: 0.04, voices: 1, chorus: 0 } },
    { id: 'strings', name: '스트링', description: '천천히 피어나는 앙상블 스트링', params: { saw: 1, pulse: 0.4, pwm: 0.35, pwmSource: 1, hpf: 2, cutoff: 3200, resonance: 0.05, envAmount: 0.05, keyTrack: 0.6, attack: 0.35, decay: 1, sustain: 0.9, release: 0.9, lfoRate: 5.5, lfoDelay: 0.6, vibrato: 0.15, chorus: 3 } },
    { id: 'pluck', name: '아르페지오 플럭', description: '아르페지에이터에 어울리는 짧은 플럭', params: { saw: 0.6, pulse: 0.7, pwm: 0.4, pwmSource: 2, cutoff: 500, resonance: 0.45, envAmount: 0.6, decay: 0.25, sustain: 0, release: 0.22, velocity: 0.6, voices: 8, chorus: 1 } },
    { id: 'lead', name: '네온 리드', description: '포르타멘토와 지연 비브라토의 모노 리드', params: { saw: 1, sub: 0.4, cutoff: 2600, resonance: 0.4, envAmount: 0.3, lfoRate: 5.5, lfoDelay: 0.4, vibrato: 0.25, glide: 0.08, voices: 1, chorus: 1 } },
  ],
}

/** Complete parameter set of a preset (defaults + overrides). */
export function presetParams(id: VintageInstrumentId, preset: VintagePreset): Record<string, number> {
  return Object.fromEntries(VINTAGE_PARAMS[id].map(def => [def.id, preset.params[def.id] ?? def.default]))
}

/** The factory preset whose complete parameter set equals `params` (within rounding), if any. */
export function matchingPreset(id: VintageInstrumentId, params: Readonly<Record<string, number>>): VintagePreset | undefined {
  return VINTAGE_PRESETS[id].find(preset => {
    const full = presetParams(id, preset)
    return VINTAGE_PARAMS[id].every(def => Math.abs((params[def.id] ?? def.default) - full[def.id]) < 1e-6)
  })
}
