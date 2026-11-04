import type { EffectDef, ParamDef } from '../contracts.js'

/** All saved controls are numeric; this fits the existing schema-5 device state. */
export const GUITAR_RIG_PARAMS: readonly ParamDef[] = [
  { id: 'compSustain', label: '서스테인', min: 0, max: 1, default: 0.35, unit: 'pct' },
  { id: 'compAttack', label: '어택', min: 0.5, max: 50, default: 10, unit: 'ms', scale: 'log' },
  { id: 'compLevel', label: '레벨', min: -18, max: 18, default: 0, unit: 'db' },
  { id: 'driveGain', label: '드라이브', min: 0, max: 30, default: 9, unit: 'db' },
  { id: 'driveTone', label: '톤', min: 0, max: 1, default: 0.5, unit: 'pct' },
  { id: 'driveLevel', label: '레벨', min: -24, max: 12, default: -3, unit: 'db' },
  { id: 'chorusRate', label: '속도', min: 0.1, max: 5, default: 0.8, unit: 'hz', scale: 'log' },
  { id: 'chorusDepth', label: '깊이', min: 0, max: 1, default: 0.35, unit: 'pct' },
  { id: 'chorusMix', label: '믹스', min: 0, max: 0.6, default: 0.25, unit: 'pct' },
  { id: 'delayTime', label: '시간', min: 30, max: 1200, default: 320, unit: 'ms', scale: 'log' },
  { id: 'delayFeedback', label: '반복', min: 0, max: 0.85, default: 0.3, unit: 'pct' },
  { id: 'delayMix', label: '믹스', min: 0, max: 0.6, default: 0.2, unit: 'pct' },
  { id: 'ampGain', label: '게인', min: 0, max: 36, default: 10, unit: 'db' },
  { id: 'ampBass', label: '베이스', min: -12, max: 12, default: 0, unit: 'db' },
  { id: 'ampMid', label: '미들', min: -12, max: 12, default: 0, unit: 'db' },
  { id: 'ampTreble', label: '트레블', min: -12, max: 12, default: 0, unit: 'db' },
  { id: 'ampPresence', label: '프레즌스', min: -9, max: 9, default: 0, unit: 'db' },
  { id: 'ampLevel', label: '마스터', min: -36, max: 6, default: -6, unit: 'db' },
  { id: 'compEnabled', label: '컴프', min: 0, max: 1, default: 1, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'driveEnabled', label: '드라이브', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'chorusEnabled', label: '코러스', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'delayEnabled', label: '딜레이', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'ampEnabled', label: '앰프', min: 0, max: 1, default: 1, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'cabinetEnabled', label: '캐비닛', min: 0, max: 1, default: 1, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'ampModel', label: '앰프 성향', min: 0, max: 2, default: 0, unit: 'x', options: [{ value: 0, label: 'Clean' }, { value: 1, label: 'Crunch' }, { value: 2, label: 'Lead' }] },
  { id: 'cabinet', label: '캐비닛 성향', min: 0, max: 2, default: 1, unit: 'x', options: [{ value: 0, label: 'Compact' }, { value: 1, label: 'Open' }, { value: 2, label: 'Stack' }] },
  { id: 'micType', label: '마이크 성향', min: 0, max: 2, default: 0, unit: 'x', options: [{ value: 0, label: 'Dynamic' }, { value: 1, label: 'Ribbon' }, { value: 2, label: 'Condenser' }] },
  { id: 'micPosition', label: '중앙 → 가장자리', min: 0, max: 1, default: 0.35, unit: 'pct' },
  { id: 'micDistance', label: '가까이 → 멀리', min: 0, max: 1, default: 0.15, unit: 'pct' },
]

export interface GuitarRigSection {
  id: 'comp' | 'drive' | 'chorus' | 'delay' | 'amp' | 'cabinet'
  name: string
  enabledParam: string
  params: readonly string[]
}

/** Presentation order follows the pedalboard; DSP routes modulation after the cab. */
export const GUITAR_RIG_SECTIONS: readonly GuitarRigSection[] = [
  { id: 'comp', name: 'COMP', enabledParam: 'compEnabled', params: ['compSustain', 'compAttack', 'compLevel'] },
  { id: 'drive', name: 'DRIVE', enabledParam: 'driveEnabled', params: ['driveGain', 'driveTone', 'driveLevel'] },
  { id: 'chorus', name: 'CHORUS', enabledParam: 'chorusEnabled', params: ['chorusRate', 'chorusDepth', 'chorusMix'] },
  { id: 'delay', name: 'DELAY', enabledParam: 'delayEnabled', params: ['delayTime', 'delayFeedback', 'delayMix'] },
  { id: 'amp', name: 'AMP', enabledParam: 'ampEnabled', params: ['ampGain', 'ampBass', 'ampMid', 'ampTreble', 'ampPresence', 'ampLevel'] },
  { id: 'cabinet', name: 'CABINET / MIC', enabledParam: 'cabinetEnabled', params: ['cabinet', 'micType', 'micPosition', 'micDistance'] },
]

export const GUITAR_RIG_DEFAULTS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(GUITAR_RIG_PARAMS.map(p => [p.id, p.default])))
export interface GuitarRigPreset { id: string; name: string; description: string; params: Readonly<Record<string, number>> }
const preset = (id: string, name: string, description: string, params: Record<string, number>): GuitarRigPreset => ({ id, name, description, params: { ...GUITAR_RIG_DEFAULTS, ...params } })
export const GUITAR_RIG_PRESETS: readonly GuitarRigPreset[] = [
  preset('clean', 'Clean Start', '컴프를 가볍게 건 깨끗한 기본 톤', {}),
  preset('edge', 'Edge Rhythm', '가벼운 오버드라이브와 크런치', { compSustain: 0.2, driveEnabled: 1, driveGain: 6, driveLevel: -6, ampModel: 1, ampGain: 7, ampBass: -2, ampPresence: -1, ampLevel: -9, micPosition: 0.45 }),
  preset('lead', 'Warm Lead', '부드러운 리드와 짧은 반복', { compSustain: 0.5, ampModel: 2, ampGain: 16, ampMid: 3, ampTreble: -2, ampLevel: -12, cabinet: 2, micType: 1, delayEnabled: 1, delayTime: 300, delayFeedback: 0.24, delayMix: 0.17 }),
  preset('wide-clean', 'Wide Clean', '코러스와 딜레이를 더한 클린', { chorusEnabled: 1, chorusRate: 0.65, chorusDepth: 0.4, chorusMix: 0.27, delayEnabled: 1, delayTime: 420, delayFeedback: 0.33, delayMix: 0.16, ampGain: 6, ampLevel: -7, micType: 2, micDistance: 0.4 }),
]

export const guitarRigDefinition: EffectDef = { name: '기타 앰프', short: '기타 앰프', params: GUITAR_RIG_PARAMS }
/** Descriptive filter voicings, not measured cabinets, named-hardware replicas, or neural captures. */
export const GUITAR_RIG_SOUND_DESCRIPTION = '알고리즘 앰프 · 캐비닛/마이크 필터 모델'
