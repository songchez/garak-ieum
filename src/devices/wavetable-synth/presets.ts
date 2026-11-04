import { cloneWavetablePatch, createDefaultWavetablePatch, parseWavetablePatch } from './model'
import type { WavetableModRoute, WavetableModSource, WavetableParams, WavetablePatch, WavetableParamId } from './model'

export interface WavetablePreset {
  readonly id: string
  readonly name: string
  readonly nameKo: string
  readonly category: 'Init' | 'Bass' | 'Lead' | 'Pad' | 'Pluck' | 'Keys' | 'Texture'
  readonly description: string
  readonly patch: WavetablePatch
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const route = (id: string, source: WavetableModSource, destination: WavetableParamId, amount: number, bipolar = false, aux: WavetableModSource | null = null, curve = 0): WavetableModRoute =>
  ({ id, enabled: true, source, destination, amount, bipolar, aux, curve })

function preset(
  id: string, name: string, nameKo: string, category: WavetablePreset['category'], description: string,
  params: Partial<WavetableParams> = {}, routes: WavetableModRoute[] = [], edit?: (patch: WavetablePatch) => void,
): WavetablePreset {
  const patch = createDefaultWavetablePatch()
  Object.assign(patch.params, params)
  patch.routes = routes
  patch.metadata = { name, author: '가락이음', description }
  edit?.(patch)
  return freeze({ id, name, nameKo, category, description, patch: parseWavetablePatch(patch) })
}

/** Original recipes for this synth; no commercial preset data or compatibility format. */
export const WAVE_PRESETS: readonly WavetablePreset[] = Object.freeze([
  preset('init', 'Init Wave', '기본 웨이브', 'Init', '하나의 오실레이터로 시작하는 기본 패치.'),
  preset('low-orbit', 'Low Orbit', '낮은 궤도', 'Bass', '짧은 필터 어택과 사인 서브가 만드는 단단한 베이스. 매크로 1은 필터를 엽니다.', {
    osc1Position: 0.64, osc1Level: 0.7, subLevel: 0.32, subOctave: -1,
    filter1Cutoff: 170, filter1Resonance: 0.18,
    env1Attack: 0.003, env1Decay: 0.24, env1Sustain: 0.68, env1Release: 0.09,
    env2Attack: 0.001, env2Decay: 0.2, env2Sustain: 0, env2Release: 0.08,
    drive: 0.24, driveMix: 0.2, level: 0.66,
  }, [route('bass-env', 'env2', 'filter1Cutoff', 0.37), route('bass-macro', 'macro1', 'filter1Cutoff', 0.3)]),
  preset('glass-stream', 'Glass Stream', '유리 물결', 'Pluck', '밝은 배음이 짧게 내려앉고 딜레이가 뒤따르는 플럭.', {
    osc1Bank: 2, osc1Position: 0.28, osc1Level: 0.6, osc1Unison: 3, osc1Detune: 5,
    filter1Cutoff: 3300, filter1Resonance: 0.14,
    env1Attack: 0.002, env1Decay: 0.52, env1Sustain: 0.03, env1Release: 0.38,
    env2Attack: 0.001, env2Decay: 0.2, env2Sustain: 0,
    chorusMix: 0.08, delayTime: 0.375, delayFeedback: 0.34, delayMix: 0.22,
  }, [route('glass-env', 'env2', 'filter1Cutoff', 0.2), route('glass-velocity', 'velocity', 'osc1Position', 0.18)]),
  preset('warm-loft', 'Warm Loft', '따뜻한 다락', 'Pad', '느린 엔벌로프와 서로 다른 폭의 두 레이어가 겹치는 패드.', {
    osc1Position: 0.52, osc1Unison: 5, osc1Detune: 9, osc1Spread: 0.8, osc1RandomPhase: 1, osc1Level: 0.5,
    osc2Enabled: 1, osc2Bank: 1, osc2Position: 0.3, osc2Unison: 3, osc2Detune: 5, osc2Tune: 12, osc2Level: 0.2, osc2RandomPhase: 1,
    filter1Cutoff: 2800, filter1Resonance: 0.08,
    env1Attack: 1.2, env1Decay: 1.4, env1Sustain: 0.8, env1Release: 2.5,
    lfo1Rate: 0.12, lfo1Retrigger: 0, chorusRate: 0.2, chorusDepth: 0.4, chorusMix: 0.22,
    delayTime: 0.6, delayFeedback: 0.4, delayMix: 0.13, level: 0.62,
  }, [route('loft-motion', 'lfo1', 'osc1Position', 0.12, true), route('loft-macro', 'macro1', 'filter1Cutoff', 0.24)]),
  preset('neon-thread', 'Neon Thread', '네온 실', 'Lead', '병렬 필터와 옥타브 레이어가 만드는 선명한 리드. 매크로 2로 비브라토 깊이를 조절합니다.', {
    osc1Bank: 2, osc1Position: 0.45, osc1Unison: 3, osc1Detune: 7, osc1Level: 0.53,
    osc2Enabled: 1, osc2Bank: 1, osc2Position: 0.2, osc2Tune: 12, osc2Level: 0.2,
    filter1Cutoff: 4700, filter1Resonance: 0.15,
    filter2Enabled: 1, filter2Type: 2, filter2Cutoff: 1600, filter2Resonance: 0.28, filterRouting: 1, filterBlend: 0.22,
    env1Attack: 0.008, env1Decay: 0.18, env1Sustain: 0.72, env1Release: 0.14,
    lfo1Rate: 5.2, macro2: 0.2, drive: 0.12, driveMix: 0.25,
    delayTime: 0.25, delayFeedback: 0.28, delayMix: 0.18,
  }, [route('neon-vibrato', 'lfo1', 'osc1Tune', 0.004, true, 'macro2'), route('neon-frame', 'macro1', 'osc1Position', 0.3)]),
  preset('air-reed', 'Air Reed', '바람 리드', 'Keys', '빈 관 같은 홀수 배음에 작은 노이즈를 더한 부드러운 건반.', {
    osc1Bank: 1, osc1Position: 0.32, osc1Level: 0.7, noiseLevel: 0.018,
    filter1Cutoff: 2700, filter1Resonance: 0.12,
    env1Attack: 0.035, env1Hold: 0.025, env1Decay: 0.16, env1Sustain: 0.68, env1Release: 0.2,
    lfo1Rate: 4.6, macro2: 0.12, chorusMix: 0.08,
  }, [route('reed-touch', 'velocity', 'filter1Cutoff', 0.14), route('reed-vibrato', 'lfo1', 'osc1Tune', 0.003, true, 'macro2')]),
  preset('copper-bell', 'Copper Bell', '구리 종', 'Keys', '오르간과 밝은 배음을 겹쳐 길게 감쇠시키는 종 형태의 음색.', {
    osc1Bank: 2, osc1Position: 0.63, osc1Level: 0.45,
    osc2Enabled: 1, osc2Bank: 3, osc2Position: 0.62, osc2Tune: 19, osc2Level: 0.19,
    filter1Cutoff: 8700, filter1Resonance: 0.04,
    env1Attack: 0.002, env1Decay: 2.2, env1Sustain: 0, env1Release: 1.5,
    env2Decay: 0.8, env2Sustain: 0, delayTime: 0.44, delayFeedback: 0.32, delayMix: 0.2,
  }, [route('bell-frame', 'env2', 'osc1Position', -0.28), route('bell-touch', 'velocity', 'osc2Level', 0.15)]),
  preset('reed-motion', 'Reed Motion', '움직이는 갈대', 'Texture', '박자에 맞춰 프레임을 왕복하는 홀수 배음 텍스처.', {
    osc1Bank: 1, osc1Position: 0.5, osc1Unison: 3, osc1Detune: 6, osc1Level: 0.58,
    filter1Cutoff: 4200, filter1Resonance: 0.2,
    env1Attack: 0.04, env1Hold: 0.08, env1Decay: 0.4, env1Sustain: 0.6, env1Release: 0.7,
    lfo1Sync: 1, lfo1Division: 4, lfo1Retrigger: 0,
    chorusRate: 0.4, chorusDepth: 0.4, chorusMix: 0.17, delayMix: 0.12,
  }, [route('reed-scan', 'lfo1', 'osc1Position', 0.34, true), route('reed-pan', 'lfo2', 'osc1Pan', 0.18, true)]),
  preset('night-current', 'Night Current', '밤의 흐름', 'Pad', '세 웨이브테이블을 낮게 섞고 느린 변조로 색을 바꾸는 패드.', {
    osc1Bank: 3, osc1Position: 0.6, osc1Unison: 3, osc1Detune: 4, osc1Level: 0.34, osc1RandomPhase: 1,
    osc2Enabled: 1, osc2Bank: 1, osc2Position: 0.5, osc2Tune: -12, osc2Level: 0.18, osc2Pan: -0.3,
    osc3Enabled: 1, osc3Bank: 2, osc3Position: 0.4, osc3Tune: 12, osc3Unison: 3, osc3Detune: 8, osc3Level: 0.12, osc3Pan: 0.3,
    filter1Cutoff: 1900, filter1Resonance: 0.1, filter2Enabled: 1, filter2Type: 1, filter2Cutoff: 100,
    env1Attack: 1.8, env1Decay: 2, env1Sustain: 0.7, env1Release: 3.2,
    lfo1Rate: 0.08, lfo1Retrigger: 0, lfo2Rate: 0.13, lfo2Retrigger: 0,
    chorusMix: 0.2, delayTime: 0.72, delayFeedback: 0.45, delayMix: 0.18, level: 0.63,
  }, [route('night-scan', 'lfo1', 'osc3Position', 0.18, true), route('night-filter', 'lfo2', 'filter1Cutoff', 0.08, true), route('night-air', 'macro1', 'noiseLevel', 0.05)]),
  preset('pulse-garden', 'Pulse Garden', '맥박 정원', 'Texture', '직접 그린 LFO 곡선으로 레벨을 움직이는 리듬 텍스처.', {
    osc1Bank: 0, osc1Position: 0.8, osc1Unison: 3, osc1Detune: 5, osc1Level: 0.64,
    filter1Cutoff: 2400, filter1Resonance: 0.16,
    env1Attack: 0.02, env1Decay: 0.2, env1Sustain: 0.85, env1Release: 0.35,
    lfo1Sync: 1, lfo1Division: 4, lfo1Retrigger: 0,
    delayTime: 0.1875, delayFeedback: 0.3, delayMix: 0.18,
  }, [route('garden-gate', 'lfo1', 'osc1Level', -0.58), route('garden-tone', 'lfo1', 'filter1Cutoff', -0.1)], patch => {
    const steps = [0, 0.9, 0.3, 1, 0, 0.65, 0.85, 1]
    patch.lfoCurves[0] = Array.from({ length: 128 }, (_, point) => steps[Math.floor(point / 16)])
  }),
])

export function getWavetablePreset(id: string): WavetablePatch {
  const preset = WAVE_PRESETS.find(item => item.id === id)
  if (!preset) throw new Error(`알 수 없는 이음 웨이브 프리셋: ${id}`)
  return cloneWavetablePatch(preset.patch)
}
