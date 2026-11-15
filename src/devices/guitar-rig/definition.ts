import type { EffectDef, ParamDef } from '../contracts.js'

/**
 * Rack modules in the order a user can arrange them. The numeric code is what a rack slot stores,
 * so it must never be renumbered; new modules get new codes. Keep in sync with native/src/dsp.cpp.
 */
export const GUITAR_RIG_MODULES = [
  { code: 1, id: 'comp', label: '컴프' },
  { code: 2, id: 'drive', label: '드라이브' },
  { code: 3, id: 'amp', label: '앰프' },
  { code: 4, id: 'cabinet', label: '캐비닛' },
  { code: 5, id: 'chorus', label: '코러스' },
  { code: 6, id: 'delay', label: '딜레이' },
  { code: 7, id: 'fuzz', label: '퍼즈' },
  { code: 8, id: 'phaser', label: '페이저' },
  { code: 9, id: 'tremolo', label: '트레몰로' },
  { code: 10, id: 'reverb', label: '리버브' },
  { code: 11, id: 'tuner', label: '튜너' },
] as const
export type GuitarRigModuleId = typeof GUITAR_RIG_MODULES[number]['id']
/** 8 pedals before the amp, the amp and the cabinet, 8 pedals after it. */
export const GUITAR_RIG_SLOT_COUNT = 18
export const GUITAR_RIG_RACK_CAPACITY = 8
/**
 * The same module may sit in the rack more than once. A slot stores `code + 16 × instance`; instance 0
 * uses the original parameter names (so old projects load unchanged) and instance k > 0 appends `_${k + 1}`
 * (`driveGain_2`). Keep in sync with native/src/dsp.cpp.
 */
export const GUITAR_RIG_MAX_INSTANCES = 3
export const GUITAR_RIG_INSTANCE_STRIDE = 16
/** One rack entry: the module id, plus `_2`/`_3` for a second or third copy. */
export type GuitarRigSlotKey = GuitarRigModuleId | `${GuitarRigModuleId}_${number}`
export interface GuitarRigSlot { key: GuitarRigSlotKey; id: GuitarRigModuleId; instance: number }
/** A tuner mutes the rig while engaged, so a second one would add nothing. */
export const guitarRigMaxInstances = (id: GuitarRigModuleId) => id === 'tuner' ? 1 : GUITAR_RIG_MAX_INSTANCES
export const rigParam = (base: string, instance: number) => instance > 0 ? `${base}_${instance + 1}` : base
export const rigSlotKey = (id: GuitarRigModuleId, instance: number): GuitarRigSlotKey => instance > 0 ? `${id}_${instance + 1}` : id
export function parseRigSlot(key: GuitarRigSlotKey): GuitarRigSlot {
  const match = /^([a-z]+)(?:_(\d+))?$/.exec(key)
  return { key, id: (match?.[1] ?? key) as GuitarRigModuleId, instance: match?.[2] ? Number(match[2]) - 1 : 0 }
}
/** New modules are never added here: projects saved before they existed must keep sounding the same. */
export const GUITAR_RIG_DEFAULT_ORDER: readonly GuitarRigSlotKey[] = ['comp', 'drive', 'amp', 'cabinet', 'chorus', 'delay']
const MAX_MODULE_CODE = Math.max(...GUITAR_RIG_MODULES.map(m => m.code))
const MAX_SLOT_VALUE = MAX_MODULE_CODE + GUITAR_RIG_INSTANCE_STRIDE * (GUITAR_RIG_MAX_INSTANCES - 1)
const MODULE_BY_CODE = new Map<number, GuitarRigModuleId>(GUITAR_RIG_MODULES.map(m => [m.code, m.id]))
const CODE_BY_MODULE = new Map<GuitarRigModuleId, number>(GUITAR_RIG_MODULES.map(m => [m.id, m.code]))
const slotId = (index: number) => `rackSlot${index}`
const slotValue = (key: GuitarRigSlotKey) => { const slot = parseRigSlot(key); return CODE_BY_MODULE.get(slot.id)! + GUITAR_RIG_INSTANCE_STRIDE * slot.instance }
const SLOT_PARAMS: ParamDef[] = Array.from({ length: GUITAR_RIG_SLOT_COUNT }, (_, index) => ({
  id: slotId(index), label: `랙 ${index + 1}번`, min: 0, max: MAX_SLOT_VALUE, unit: 'x',
  default: GUITAR_RIG_DEFAULT_ORDER[index] ? slotValue(GUITAR_RIG_DEFAULT_ORDER[index]) : 0,
  options: [{ value: 0, label: '비어 있음' }, ...GUITAR_RIG_MODULES.flatMap(m => Array.from({ length: guitarRigMaxInstances(m.id) }, (_, instance) => ({ value: m.code + GUITAR_RIG_INSTANCE_STRIDE * instance, label: instance ? `${m.label} ${instance + 1}` : m.label })))],
}))

/** Signal order stored in the rack slots. Empty, unknown and repeated entries are skipped. */
export function guitarRigOrder(params: Readonly<Record<string, number>>): GuitarRigSlotKey[] {
  const order: GuitarRigSlotKey[] = []
  for (let index = 0; index < GUITAR_RIG_SLOT_COUNT; index += 1) {
    const raw = params[slotId(index)]
    const value = Math.round(Number.isFinite(raw) ? raw : SLOT_PARAMS[index].default)
    if (value <= 0) continue
    const id = MODULE_BY_CODE.get(value % GUITAR_RIG_INSTANCE_STRIDE), instance = Math.floor(value / GUITAR_RIG_INSTANCE_STRIDE)
    if (!id || instance >= guitarRigMaxInstances(id)) continue
    const key = rigSlotKey(id, instance)
    if (!order.includes(key)) order.push(key)
  }
  return order
}

/** Parameter patch that stores `order` in the rack slots (unused slots are cleared). */
export function guitarRigOrderParams(order: readonly GuitarRigSlotKey[]): Record<string, number> {
  const unique = order.filter((key, index) => order.indexOf(key) === index).slice(0, GUITAR_RIG_SLOT_COUNT)
  return Object.fromEntries(Array.from({ length: GUITAR_RIG_SLOT_COUNT }, (_, index) => [slotId(index), unique[index] ? slotValue(unique[index]) : 0]))
}

/** The lowest instance of `id` not already in `order`, or null when every copy is in use. */
export function nextRigInstance(order: readonly GuitarRigSlotKey[], id: GuitarRigModuleId): GuitarRigSlotKey | null {
  for (let instance = 0; instance < guitarRigMaxInstances(id); instance += 1) { const key = rigSlotKey(id, instance); if (!order.includes(key)) return key }
  return null
}

/** All saved controls are numeric; this fits the existing schema-5 device state. */
const BASE_PARAMS: readonly ParamDef[] = [
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
  { id: 'ampModel', label: '앰프', min: 0, max: 4, default: 0, unit: 'x', options: [{ value: 0, label: "Twinline '65 · Clean" }, { value: 4, label: '청자 Jazz · Warm Clean' }, { value: 3, label: 'Topboost 30 · Chime' }, { value: 1, label: 'Plexton 59 · Crunch' }, { value: 2, label: '옹기 Lead · High Gain' }] },
  { id: 'cabinet', label: '캐비닛', min: 0, max: 4, default: 1, unit: 'x', options: [{ value: 3, label: '장독 1×10 · Tiny' }, { value: 0, label: '소반 1×12 · Tweed' }, { value: 1, label: 'Blackline 2×12 · Open' }, { value: 4, label: 'Chime 2×12 · Open' }, { value: 2, label: 'Brit 4×12 · Stack' }] },
  { id: 'micType', label: '마이크', min: 0, max: 4, default: 0, unit: 'x', options: [{ value: 0, label: 'DM-75 · Dynamic' }, { value: 3, label: '장구 D42 · Large Dynamic' }, { value: 1, label: 'RB-212 · Ribbon' }, { value: 2, label: '달항아리 C8 · Condenser' }, { value: 4, label: 'Pencil 84 · Small Condenser' }] },
  { id: 'micPosition', label: '중앙 → 가장자리', min: 0, max: 1, default: 0.35, unit: 'pct' },
  { id: 'micDistance', label: '가까이 → 멀리', min: 0, max: 1, default: 0.15, unit: 'pct' },
  { id: 'fuzzGain', label: '퍼즈', min: 0, max: 40, default: 26, unit: 'db' },
  { id: 'fuzzTone', label: '톤', min: 0, max: 1, default: 0.45, unit: 'pct' },
  { id: 'fuzzLevel', label: '레벨', min: -36, max: 0, default: -14, unit: 'db' },
  { id: 'phaserRate', label: '속도', min: 0.05, max: 4, default: 0.45, unit: 'hz', scale: 'log' },
  { id: 'phaserDepth', label: '깊이', min: 0, max: 1, default: 0.7, unit: 'pct' },
  { id: 'phaserFeedback', label: '피드백', min: 0, max: 0.85, default: 0.35, unit: 'pct' },
  { id: 'tremoloRate', label: '속도', min: 0.5, max: 12, default: 4.5, unit: 'hz', scale: 'log' },
  { id: 'tremoloDepth', label: '깊이', min: 0, max: 1, default: 0.5, unit: 'pct' },
  { id: 'tremoloShape', label: '모양', min: 0, max: 1, default: 0, unit: 'pct' },
  { id: 'reverbDecay', label: '잔향', min: 0, max: 1, default: 0.45, unit: 'pct' },
  { id: 'reverbTone', label: '톤', min: 0, max: 1, default: 0.5, unit: 'pct' },
  { id: 'reverbMix', label: '믹스', min: 0, max: 0.8, default: 0.25, unit: 'pct' },
  { id: 'fuzzEnabled', label: '퍼즈', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'phaserEnabled', label: '페이저', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'tremoloEnabled', label: '트레몰로', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'reverbEnabled', label: '리버브', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
  { id: 'tunerEnabled', label: '튜너(켜면 음소거)', min: 0, max: 1, default: 0, unit: 'x', options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }] },
]

export interface GuitarRigSection {
  id: GuitarRigModuleId
  name: string
  enabledParam: string
  params: readonly string[]
}

/** One entry per rack module: its bypass switch and the knobs shown on its face (the tuner has none). */
export const GUITAR_RIG_SECTIONS: readonly GuitarRigSection[] = [
  { id: 'comp', name: 'COMP', enabledParam: 'compEnabled', params: ['compSustain', 'compAttack', 'compLevel'] },
  { id: 'drive', name: 'DRIVE', enabledParam: 'driveEnabled', params: ['driveGain', 'driveTone', 'driveLevel'] },
  { id: 'chorus', name: 'CHORUS', enabledParam: 'chorusEnabled', params: ['chorusRate', 'chorusDepth', 'chorusMix'] },
  { id: 'delay', name: 'DELAY', enabledParam: 'delayEnabled', params: ['delayTime', 'delayFeedback', 'delayMix'] },
  { id: 'amp', name: 'AMP', enabledParam: 'ampEnabled', params: ['ampGain', 'ampBass', 'ampMid', 'ampTreble', 'ampPresence', 'ampLevel'] },
  { id: 'cabinet', name: 'CABINET / MIC', enabledParam: 'cabinetEnabled', params: ['cabinet', 'micType', 'micPosition', 'micDistance'] },
  { id: 'fuzz', name: 'FUZZ', enabledParam: 'fuzzEnabled', params: ['fuzzGain', 'fuzzTone', 'fuzzLevel'] },
  { id: 'phaser', name: 'PHASER', enabledParam: 'phaserEnabled', params: ['phaserRate', 'phaserDepth', 'phaserFeedback'] },
  { id: 'tremolo', name: 'TREMOLO', enabledParam: 'tremoloEnabled', params: ['tremoloRate', 'tremoloDepth', 'tremoloShape'] },
  { id: 'reverb', name: 'REVERB', enabledParam: 'reverbEnabled', params: ['reverbDecay', 'reverbTone', 'reverbMix'] },
  { id: 'tuner', name: 'TUNER', enabledParam: 'tunerEnabled', params: [] },
]

/** Every parameter one copy of a module owns: its bypass switch, its knobs and its model selectors. */
export const GUITAR_RIG_MODULE_PARAMS: Readonly<Record<GuitarRigModuleId, readonly string[]>> = Object.fromEntries(GUITAR_RIG_SECTIONS.map(section => [
  section.id, [section.enabledParam, ...section.params, ...(section.id === 'amp' ? ['ampModel'] : [])],
])) as unknown as Record<GuitarRigModuleId, readonly string[]>

/** Base controls, then the second and third copies' controls, then the rack slots. */
export const GUITAR_RIG_PARAMS: readonly ParamDef[] = [
  ...BASE_PARAMS,
  ...GUITAR_RIG_MODULES.flatMap(m => Array.from({ length: guitarRigMaxInstances(m.id) - 1 }, (_, i) => i + 1).flatMap(instance =>
    GUITAR_RIG_MODULE_PARAMS[m.id].map(base => { const def = BASE_PARAMS.find(p => p.id === base)!; return { ...def, id: rigParam(base, instance), label: `${def.label} ${instance + 1}` } }))),
  ...SLOT_PARAMS,
]

export const GUITAR_RIG_DEFAULTS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(GUITAR_RIG_PARAMS.map(p => [p.id, p.default])))
export interface GuitarRigPreset { id: string; name: string; description: string; params: Readonly<Record<string, number>> }
const preset = (id: string, name: string, description: string, params: Record<string, number>): GuitarRigPreset => ({ id, name, description, params: { ...GUITAR_RIG_DEFAULTS, ...params } })
export const GUITAR_RIG_PRESETS: readonly GuitarRigPreset[] = [
  preset('clean', 'Clean Start', '컴프를 가볍게 건 깨끗한 기본 톤', {}),
  preset('edge', 'Edge Rhythm', '가벼운 오버드라이브와 크런치', { compSustain: 0.2, driveEnabled: 1, driveGain: 6, driveLevel: -6, ampModel: 1, ampGain: 7, ampBass: -2, ampPresence: -1, ampLevel: -9, micPosition: 0.45 }),
  preset('lead', 'Warm Lead', '부드러운 리드와 짧은 반복', { compSustain: 0.5, ampModel: 2, ampGain: 16, ampMid: 3, ampTreble: -2, ampLevel: -12, cabinet: 2, micType: 1, delayEnabled: 1, delayTime: 300, delayFeedback: 0.24, delayMix: 0.17 }),
  preset('wide-clean', 'Wide Clean', '코러스와 딜레이를 더한 클린', { chorusEnabled: 1, chorusRate: 0.65, chorusDepth: 0.4, chorusMix: 0.27, delayEnabled: 1, delayTime: 420, delayFeedback: 0.33, delayMix: 0.16, ampGain: 6, ampLevel: -7, micType: 2, micDistance: 0.4 }),
  preset('fuzz-swirl', 'Fuzz Swirl', '퍼즈 뒤에 페이저를 건 70년대 리드', { ...guitarRigOrderParams(['comp', 'fuzz', 'phaser', 'amp', 'cabinet', 'delay']), compSustain: 0.25, fuzzEnabled: 1, fuzzGain: 28, fuzzTone: 0.4, fuzzLevel: -16, phaserEnabled: 1, phaserRate: 0.35, phaserDepth: 0.75, phaserFeedback: 0.45, ampModel: 1, ampGain: 6, ampBass: -1, ampLevel: -10, cabinet: 2, micType: 1, delayEnabled: 1, delayTime: 380, delayFeedback: 0.22, delayMix: 0.14 }),
  preset('bell-surf', 'Bell Surf', '트레몰로와 범종 리버브를 더한 서프 클린', { ...guitarRigOrderParams(['comp', 'amp', 'cabinet', 'tremolo', 'reverb']), compSustain: 0.3, ampModel: 3, ampGain: 8, ampTreble: 2, ampLevel: -8, cabinet: 4, micType: 4, micPosition: 0.3, tremoloEnabled: 1, tremoloRate: 5.5, tremoloDepth: 0.55, tremoloShape: 0.2, reverbEnabled: 1, reverbDecay: 0.6, reverbTone: 0.55, reverbMix: 0.32 }),
]

export const guitarRigDefinition: EffectDef = { name: '기타 앰프', short: '기타 앰프', params: GUITAR_RIG_PARAMS }
/** Descriptive filter voicings, not measured cabinets, named-hardware replicas, or neural captures. */
export const GUITAR_RIG_SOUND_DESCRIPTION = '알고리즘 앰프 · 캐비닛/마이크 필터 모델'
