import { INSTRUMENT_PARAMS, SAMPLED_KIT_PARAMS, SAMPLED_PARAMS, type ParamDef, type SynthId } from './devices'
import type { SampleAttribution } from './types'
import { WAVETABLE_DEFINITION } from '../devices/wavetable-synth/definition'

export type InstrumentKind = 'synth' | 'sampled' | 'native'
export type InstrumentCategory = 'synth' | 'piano' | 'keys' | 'drums' | 'gugak'

export interface InstrumentDef {
  id: string
  name: string
  nameKo: string
  /** Short uppercase type line shown under the name in the browser. */
  type: string
  category: InstrumentCategory
  kind: InstrumentKind
  isKit: boolean
  icon: string
  color: string
  description: string
  /** Folder under public/samples for sampled instruments. */
  set?: string
  /** Lane labels for kits; General MIDI names are used when absent. */
  padNames?: Readonly<Record<number, string>>
  params: readonly ParamDef[]
}

export const GM_KIT_NAMES: Readonly<Record<number, string>> = {
  35: 'LOW KICK', 36: 'KICK', 37: 'RIM', 38: 'SNARE', 39: 'CLAP', 40: 'SNARE 2',
  41: 'LOW TOM', 42: 'CLOSED HAT', 43: 'MID TOM', 44: 'PEDAL HAT', 45: 'HIGH TOM',
  46: 'OPEN HAT', 47: 'MID TOM 2', 48: 'HI MID TOM', 49: 'CRASH', 50: 'HI TOM', 51: 'RIDE', 53: 'RIDE BELL',
}

const SAMUL_NAMES: Readonly<Record<number, string>> = {
  36: '북', 37: '박', 38: '장구 덩', 39: '장구 기덕', 40: '장구 덕', 41: '장구 쿵', 42: '꽹과리 갱', 43: '장구 더',
  44: '꽹과리 지', 45: '좌고', 46: '꽹과리 객', 47: '바라', 48: '꽹과리 갯', 49: '징 강', 50: '꽹과리 개ㅅ', 51: '징 약',
}

const synth = (id: SynthId, name: string, nameKo: string, type: string, category: InstrumentCategory, icon: string, color: string, description: string): InstrumentDef =>
  ({ id, name, nameKo, type, category, kind: 'synth', isKit: id === 'drums', icon, color, description, params: INSTRUMENT_PARAMS[id] })

// Generic instrument-family symbols, not drawings of the individual Korean instruments.
const SAMPLED_ICONS: Readonly<Record<string, string>> = {
  samul: 'drum', gayageum: 'strings', haegeum: 'strings', daegeum: 'wind',
}

const sampled = (id: string, set: string, name: string, nameKo: string, type: string, category: InstrumentCategory, isKit: boolean, color: string, description: string, padNames?: Readonly<Record<number, string>>): InstrumentDef =>
  ({ id, name, nameKo, type, category, kind: 'sampled', isKit, icon: SAMPLED_ICONS[id] ?? categoryIcon(category), color, description, set, padNames, params: isKit ? SAMPLED_KIT_PARAMS : SAMPLED_PARAMS })

export function categoryIcon(category: InstrumentCategory): string {
  switch (category) {
    case 'drums': return 'drum'
    case 'piano': case 'keys': return 'keys'
    case 'gugak': return 'note'
    default: return 'synth'
  }
}

/** IDs are stable; saved projects reference them by name. */
export const INSTRUMENTS: readonly InstrumentDef[] = [
  WAVETABLE_DEFINITION,
  synth('keys', 'Velvet Keys', '벨벳 키', 'ELECTRIC PIANO', 'synth', 'keys', '#6f9fd0', '부드러운 건반과 따뜻한 하모닉스'),
  synth('rhodes', 'Tine EP', '틴 전기 피아노', 'FM TINE PIANO', 'keys', 'keys', '#86a8d8', 'FM 타인으로 만든 전기 피아노'),
  synth('bass', 'Mono Bass', '모노 베이스', 'ANALOG BASS', 'synth', 'synth', '#7fb59a', '낮게 흐르는 아날로그 베이스'),
  synth('drums', 'Pocket Drums', '포켓 드럼', 'DRUM MACHINE', 'synth', 'drum', '#e38457', '킥 · 스네어 · 하이햇 · 퍼커션'),
  synth('pad', 'Cloud Pad', '클라우드 패드', 'ATMOSPHERIC', 'synth', 'pad', '#8cc7c0', '공간을 채우는 부드러운 패드'),
  synth('pluck', 'Glass Pluck', '글라스 플럭', 'PLUCK SYNTH', 'synth', 'note', '#d98a9f', '반짝이는 짧은 플럭 사운드'),
  sampled('grand', 'salamander', 'Grand Piano', '그랜드 피아노', 'SAMPLED GRAND', 'piano', false, '#d9b45a', '세 단계 세기로 녹음한 콘서트 그랜드'),
  sampled('wurlitzer', 'wurlitzer', 'Wurlitzer EP', '월리처', 'SAMPLED EP', 'keys', false, '#6f9fd0', '따뜻하게 일그러지는 빈티지 전기 피아노'),
  sampled('kit-acoustic', 'kit-acoustic', 'Studio Kit', '스튜디오 드럼', 'ACOUSTIC KIT', 'drums', true, '#e38457', '자연스러운 어쿠스틱 스튜디오 드럼'),
  sampled('kit-808', 'kit-808', '808 Kit', '808 드럼', 'ELECTRONIC KIT', 'drums', true, '#d96f5a', '묵직한 808 킥과 전자 퍼커션'),
  sampled('kit-lofi', 'kit-lofi', 'Lo-fi Kit', '로파이 드럼', 'LO-FI KIT', 'drums', true, '#c98f6c', '먼지 낀 질감의 로파이 드럼'),
  sampled('samul', 'samul', 'Samulnori', '사물놀이', 'PERCUSSION KIT', 'gugak', true, '#b5533c', '꽹과리 · 징 · 장구 · 북', SAMUL_NAMES),
  sampled('gayageum', 'gayageum', 'Gayageum', '가야금', 'PLUCKED STRING', 'gugak', false, '#c9a06a', '열두 줄을 뜯는 가야금'),
  sampled('haegeum', 'haegeum', 'Haegeum', '해금', 'BOWED STRING', 'gugak', false, '#c4876b', '두 줄 찰현악기 해금의 선율'),
  sampled('daegeum', 'daegeum', 'Daegeum', '대금', 'BAMBOO FLUTE', 'gugak', false, '#9fb088', '대나무 관의 깊은 숨, 대금'),
]

export const INSTRUMENT_SECTIONS: readonly { title: string; categories: readonly InstrumentCategory[] }[] = [
  { title: '신스', categories: ['synth'] },
  { title: '피아노·건반', categories: ['piano', 'keys'] },
  { title: '드럼', categories: ['drums'] },
  { title: '국악', categories: ['gugak'] },
]

const byId = new Map(INSTRUMENTS.map(def => [def.id, def]))
const fallback = byId.get('keys')!

export const isInstrumentId = (id: unknown): id is string => typeof id === 'string' && byId.has(id)

export function instrumentDef(id: string): InstrumentDef {
  return byId.get(id) ?? fallback
}

export const previewPitch = (def: InstrumentDef): number => def.isKit ? 38 : def.id === 'bass' ? 36 : 60

export const SAMPLE_SETS: readonly string[] = [...new Set(INSTRUMENTS.flatMap(def => def.set ? [def.set] : []))]

/** Static mirror of the manifest attributions, shown in the about dialog before any set loads. */
export const SAMPLE_CREDITS: readonly (SampleAttribution & { instruments: string })[] = [
  { title: 'Salamander Grand Piano V3', author: 'Alexander Holm', license: 'CC BY 3.0', url: 'https://archive.org/details/SalamanderGrandPianoV3', instruments: 'Grand Piano' },
  { title: 'Wurlitzer EP200', author: 'Greg Sullivan', license: 'CC BY 3.0 / 4.0', instruments: 'Wurlitzer EP' },
  { title: 'Virtuosity Drums', author: 'Versilian Studios · Karoryfer Samples', license: 'CC0', instruments: 'Studio Kit' },
  { title: 'VCSL (Versilian Community Sample Library)', author: 'Versilian Studios', license: 'CC0', url: 'https://github.com/sgossner/VCSL', instruments: 'Studio Kit · Lo-fi Kit' },
  { title: 'Gogodze Phu Vol II', author: 'Karoryfer Samples', license: 'CC0', instruments: 'Lo-fi Kit' },
  { title: 'TR808EmulationKit', author: 'ArtemioLabs (Hydrogen)', license: 'GPL-3.0-or-later', instruments: '808 Kit' },
  { title: '국립국악원 국악기 디지털 음원', author: '국립국악원', license: '공공누리 제1유형', url: 'https://www.gugak.go.kr/digitaleum', instruments: '사물놀이 · 가야금 · 해금 · 대금' },
]
