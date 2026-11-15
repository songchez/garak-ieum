import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { EffectDevice, Track } from '../core/types'
import type { AudioState } from '../core/audioSettings'
import { formatParam, paramValue, type ParamDef } from '../core/devices'
import { useHistoryGesture } from '../core/historyGesture'
import { guitarRigMaxInstances, guitarRigOrder, guitarRigOrderParams, nextRigInstance, parseRigSlot, rigParam, GUITAR_RIG_DEFAULTS, GUITAR_RIG_MODULE_PARAMS, GUITAR_RIG_MODULES, GUITAR_RIG_PARAMS, GUITAR_RIG_PRESETS, GUITAR_RIG_SECTIONS, GUITAR_RIG_RACK_CAPACITY, GUITAR_RIG_SOUND_DESCRIPTION, type GuitarRigModuleId, type GuitarRigSlot, type GuitarRigSlotKey } from '../devices/guitar-rig/definition'
import { loadUserPresets, MAX_PRESET_NAME, putUserPreset, removeUserPreset, saveUserPresets, USER_PRESET_STORAGE_KEY, type GuitarRigUserPreset } from '../devices/guitar-rig/userPresets'
import { detectPitch, guitarTunerTap, tunerReading, TUNER_A4, type TunerReading } from '../devices/guitar-rig/tuner'
import { isDesktopApp } from '../platform/desktop'
import { Icon } from './Icon'
import { Knob } from './Knob'
import { RigPresetPicker } from './RigPresetPicker'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import knobImage from '../assets/guitar-rig/knob-cap.png'
import knobChrome from '../assets/guitar-rig/knobs/knob-chrome.png'
import knobChicken from '../assets/guitar-rig/knobs/knob-chicken.png'
import knobGold from '../assets/guitar-rig/knobs/knob-gold.png'
import knobRed from '../assets/guitar-rig/knobs/knob-red.png'
import knobCopper from '../assets/guitar-rig/knobs/knob-copper.png'
import ampTwinline from '../assets/guitar-rig/amps/amp-twinline.webp'
import ampPlexton from '../assets/guitar-rig/amps/amp-plexton.webp'
import ampOnggi from '../assets/guitar-rig/amps/amp-onggi.webp'
import ampTopboost from '../assets/guitar-rig/amps/amp-topboost.webp'
import ampCheongja from '../assets/guitar-rig/amps/amp-cheongja.webp'
import cabinetCompactImage from '../assets/guitar-rig/cabinet-compact.webp'
import cabinetOpenImage from '../assets/guitar-rig/cabinet-open.webp'
import cabinetStackImage from '../assets/guitar-rig/cabinet-stack.webp'
import cabinetTinyImage from '../assets/guitar-rig/cabinet-tiny.webp'
import cabinetChimeImage from '../assets/guitar-rig/cabinet-chime.webp'
import micDm75 from '../assets/guitar-rig/mics/mic-dm75.webp'
import micRibbon from '../assets/guitar-rig/mics/mic-ribbon.webp'
import micMoonjar from '../assets/guitar-rig/mics/mic-moonjar.webp'
import micJanggu from '../assets/guitar-rig/mics/mic-janggu.webp'
import micPencil from '../assets/guitar-rig/mics/mic-pencil.webp'
import pedalComp from '../assets/guitar-rig/pedals/pedal-comp.webp'
import pedalDrive from '../assets/guitar-rig/pedals/pedal-drive.webp'
import pedalChorus from '../assets/guitar-rig/pedals/pedal-chorus.webp'
import pedalDelay from '../assets/guitar-rig/pedals/pedal-delay.webp'
import pedalFuzz from '../assets/guitar-rig/pedals/pedal-fuzz.webp'
import pedalPhaser from '../assets/guitar-rig/pedals/pedal-phaser.webp'
import pedalTremolo from '../assets/guitar-rig/pedals/pedal-tremolo.webp'
import pedalReverb from '../assets/guitar-rig/pedals/pedal-reverb.webp'
import pedalTuner from '../assets/guitar-rig/pedals/pedal-tuner.webp'
import './GuitarRig.css'

const PARAMS = new Map(GUITAR_RIG_PARAMS.map(def => [def.id, def]))
const AMP_IDS = ['ampGain', 'ampBass', 'ampMid', 'ampTreble', 'ampPresence', 'ampLevel'] as const
const AMP_LABELS = ['GAIN', 'BASS', 'MID', 'TREBLE', 'PRESENCE', 'MASTER'] as const
/** Knob caps per equipment style. Every cap is a 128×128 top-down image whose pointer faces up at 0°. */
const KNOB_STYLES = { cream: knobImage, chrome: knobChrome, chicken: knobChicken, gold: knobGold, red: knobRed, copper: knobCopper } as const
/** Indexed by the saved `ampModel` value. */
const AMP_KNOBS = ['chrome', 'gold', 'red', 'chicken', 'cream'] as const
/** Pedal faces carry no printed text; names live in the rack header and browser. */
const PEDAL_META = {
  comp: { name: '다듬이 Comp', image: pedalComp, knob: 'cream', labels: ['SUSTAIN', 'ATTACK', 'LEVEL'] },
  drive: { name: 'Green Howler', image: pedalDrive, knob: 'chicken', labels: ['DRIVE', 'TONE', 'LEVEL'] },
  chorus: { name: 'Blue Ripple', image: pedalChorus, knob: 'chrome', labels: ['RATE', 'DEPTH', 'MIX'] },
  delay: { name: '메아리 Delay', image: pedalDelay, knob: 'copper', labels: ['TIME', 'FEEDBACK', 'MIX'] },
  fuzz: { name: 'Bumble Fuzz', image: pedalFuzz, knob: 'chicken', labels: ['FUZZ', 'TONE', 'LEVEL'] },
  phaser: { name: 'Swirl Phase', image: pedalPhaser, knob: 'chrome', labels: ['RATE', 'DEPTH', 'FEEDBACK'] },
  tremolo: { name: 'Tide Tremolo', image: pedalTremolo, knob: 'cream', labels: ['RATE', 'DEPTH', 'SHAPE'] },
  reverb: { name: '범종 Reverb', image: pedalReverb, knob: 'copper', labels: ['DECAY', 'TONE', 'MIX'] },
  tuner: { name: '조율 Tuner', image: pedalTuner, knob: 'chrome', labels: [] },
} as const
/** The tuner pedal's dark display window in the 180×300 pedal frame: [left, top, width, height]. */
const TUNER_WINDOW = [28, 48, 134, 56] as const
/** Short labels for the compact rack summary in the device chain. */
const STAGE_LABELS: Partial<Record<GuitarRigModuleId, string>> = { cabinet: 'CAB', tremolo: 'TREM', phaser: 'PHASE' }
/**
 * Indexed by the saved `ampModel` value. `panel` is the empty control strip in the 1200×600 artwork
 * as [left, top, right, bottom] percentages; knobs and the power switch are laid out along it.
 */
const AMPS = [
  { image: ampTwinline, panel: [15, 68.3, 85, 87.3], light: true },
  { image: ampPlexton, panel: [9.2, 70, 90.8, 86.7], light: true },
  { image: ampOnggi, panel: [10.3, 65, 90, 85], light: false },
  { image: ampTopboost, panel: [9.2, 66, 91.7, 85.7], light: false },
  { image: ampCheongja, panel: [15.8, 67.7, 90, 87.3], light: true },
] as const
/** Indexed by the saved `micType` value. */
const MICS = [micDm75, micRibbon, micMoonjar, micJanggu, micPencil] as const
/** Indexed by the `cabinet` param. Speaker centre/radius are in the 768×512 artwork frame; the mic marker travels centre → edge. */
const CABINETS = [
  { image: cabinetCompactImage, alt: '트위드 마감 1×12 캐비닛, 스피커를 기준으로 마이크 위치 표시', speaker: [395, 248], radius: 138 },
  { image: cabinetOpenImage, alt: '검은 마감 2×12 오픈백 캐비닛, 왼쪽 스피커를 기준으로 마이크 위치 표시', speaker: [217, 251], radius: 123 },
  { image: cabinetStackImage, alt: '검은 마감 4×12 캐비닛, 왼쪽 위 스피커를 기준으로 마이크 위치 표시', speaker: [286, 170], radius: 75 },
  { image: cabinetTinyImage, alt: '적갈색 원목 1×10 소형 캐비닛, 스피커를 기준으로 마이크 위치 표시', speaker: [384, 262], radius: 128 },
  { image: cabinetChimeImage, alt: '크림색 마감 2×12 다이아몬드 그릴 캐비닛, 왼쪽 스피커를 기준으로 마이크 위치 표시', speaker: [242, 300], radius: 112 },
] as const
const PEDAL_POINTS = [[52, 97], [128, 97], [90, 162]] as const
const RANGE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
const valueOf = (params: Record<string, number>, id: string) => paramValue(GUITAR_RIG_PARAMS, params, id)
const choiceLabel = (params: Record<string, number>, id: string) => PARAMS.get(id)?.options?.find(option => option.value === valueOf(params, id))?.label ?? ''
const shortLabel = (params: Record<string, number>, id: string) => choiceLabel(params, id).split(' · ')[0]
const sameParams = (params: Record<string, number>, other: Readonly<Record<string, number>>) => GUITAR_RIG_PARAMS.every(def => Math.abs(valueOf(params, def.id) - (other[def.id] ?? def.default)) < 0.000001)
const matchedPreset = (params: Record<string, number>) => GUITAR_RIG_PRESETS.find(preset => sameParams(params, preset.params))
/** The user's saved presets, kept in sync with other editor windows through the storage event. */
function useUserPresets(): [GuitarRigUserPreset[], (next: GuitarRigUserPreset[]) => boolean] {
  const [list, setList] = useState(loadUserPresets)
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === USER_PRESET_STORAGE_KEY) setList(loadUserPresets()) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  return [list, next => { const ok = saveUserPresets(next); if (ok) setList(next); return ok }]
}

export function GuitarRigSummary({ device, onOpen }: { device: EffectDevice; onOpen: () => void }) {
  const [userPresets] = useUserPresets()
  const preset = matchedPreset(device.params) ?? userPresets.find(item => sameParams(device.params, item.params))
  return <div className="dc-guitar-summary">
    <button className="dc-guitar-open" onClick={onOpen} aria-haspopup="dialog" aria-label="기타 앰프 편집기 열기">
      <span className="dc-guitar-thumbnail" aria-hidden="true"><img src={(AMPS[Math.round(valueOf(device.params, 'ampModel'))] ?? AMPS[0]).image} alt="" width={1200} height={600}/></span>
      <span className="dc-guitar-title">{preset?.name ?? '나만의 톤'}<Icon name="external" size={12}/></span>
      <span className="dc-guitar-caption">{shortLabel(device.params, 'ampModel')} · {shortLabel(device.params, 'cabinet')}</span>
    </button>
    <div className="dc-guitar-stages" aria-label="기타 앰프 랙 순서">{guitarRigOrder(device.params).map(key => { const { id, instance } = parseRigSlot(key); const section = GUITAR_RIG_SECTIONS.find(item => item.id === id)!; return <span key={key} data-on={valueOf(device.params, rigParam(section.enabledParam, instance)) >= .5}>{STAGE_LABELS[id] ?? section.name}{instance ? ` ${instance + 1}` : ''}</span> })}</div>
  </div>
}

type KnobStyle = keyof typeof KNOB_STYLES
/** LFO rates are shown with decimals; the shared formatter rounds Hz to whole numbers. */
const RATE_DIGITS: Record<string, number> = { chorusRate: 2, phaserRate: 2, tremoloRate: 1 }
const formatRig = (base: string, value: number) => RATE_DIGITS[base] === undefined ? formatParam(PARAMS.get(base)!, value) : `${value.toFixed(RATE_DIGITS[base])} Hz`
function RigKnob({ id, base = id, label, section, params, onParam, knob = 'cream', size = 44 }: { id: string; base?: string; label: string; section: string; params: Record<string, number>; onParam: (key: string, value: number) => void; knob?: KnobStyle; size?: number }) {
  const def = PARAMS.get(id)!
  const baseLabel = PARAMS.get(base)?.label ?? def.label
  return <Knob def={{ ...def, label }} ariaLabel={`${section} ${baseLabel}`} value={valueOf(params, id)} size={size} imageSrc={KNOB_STYLES[knob]} formatValue={RATE_DIGITS[base] === undefined ? undefined : value => formatRig(base, value)} onChange={value => onParam(id, value)}/>
}

function RigChoice({ id, params, onParam, label }: { id: string; params: Record<string, number>; onParam: (key: string, value: number) => void; label?: string }) {
  const def = PARAMS.get(id)!
  return <label className="gr-choice"><span>{label ?? def.label}</span><select value={valueOf(params, id)} onChange={event => onParam(id, Number(event.target.value))}>{def.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
}

function RigRange({ def, value, onChange, left, right }: { def: ParamDef; value: number; onChange: (value: number) => void; left: string; right: string }) {
  const gesture = useHistoryGesture(`${def.label} 조절`)
  const end = useRef(gesture.end); end.current = gesture.end
  useEffect(() => {
    const finish = () => end.current()
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => { window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish) }
  }, [])
  return <label className="gr-range"><span>{def.label}<output>{formatParam(def, value)}</output></span>
    <input type="range" min={def.min} max={def.max} step={.01} value={value} aria-label={def.id.startsWith('micPosition')?'마이크 위치':def.id.startsWith('micDistance')?'마이크 거리':def.label} aria-valuetext={formatParam(def, value)} onChange={event => onChange(Number(event.target.value))} onPointerDown={() => gesture.begin()} onKeyDown={event => { if (RANGE_KEYS.includes(event.key)) gesture.begin() }} onKeyUp={event => { if (RANGE_KEYS.includes(event.key)) gesture.end() }} onBlur={() => gesture.end()}/>
    <small><span>{left}</span><span>{right}</span></small>
  </label>
}

interface EditorProps {
  device: EffectDevice
  track: Track
  audioState: AudioState | null
  onParam: (key: string, value: number) => void
  onParams: (params: Record<string, number>) => void
  onToggle: () => void
  onTrackChange: (patch: Partial<Track>) => void
  onOpenAudioSettings?: () => void
  onClose: () => void
}

const DRAG_TYPE = 'application/x-garak-rig-module'
const MODULE_ENABLED = Object.fromEntries(GUITAR_RIG_SECTIONS.map(section => [section.id, section.enabledParam])) as Record<GuitarRigModuleId, string>
/** Drag payloads: a browser item adds a new copy, a rack unit moves itself. */
type DragPayload = { kind: 'new'; id: GuitarRigModuleId } | { kind: 'move'; key: GuitarRigSlotKey }
const encodeDrag = (payload: DragPayload) => payload.kind === 'new' ? `new:${payload.id}` : `move:${payload.key}`
const decodeDrag = (raw: string): DragPayload | null => {
  const [kind, value] = raw.split(':')
  if (kind === 'new' && GUITAR_RIG_MODULES.some(m => m.id === value)) return { kind, id: value as GuitarRigModuleId }
  if (kind === 'move' && value) return { kind, key: value as GuitarRigSlotKey }
  return null
}
/** Fresh controls for a newly racked copy: factory values, switched on (a tuner starts off, since it mutes). */
function freshModuleParams(key: GuitarRigSlotKey): Record<string, number> {
  const { id, instance } = parseRigSlot(key)
  return Object.fromEntries(GUITAR_RIG_MODULE_PARAMS[id].map(base => [rigParam(base, instance), base === MODULE_ENABLED[id] ? (id === 'tuner' ? 0 : 1) : GUITAR_RIG_DEFAULTS[base]]))
}
function copiedModuleParams(from: GuitarRigSlotKey, to: GuitarRigSlotKey, params: Record<string, number>): Record<string, number> {
  const source = parseRigSlot(from), target = parseRigSlot(to)
  return Object.fromEntries(GUITAR_RIG_MODULE_PARAMS[source.id].map(base => [rigParam(base, target.instance), valueOf(params, rigParam(base, source.instance))]))
}

/** The two effect racks around the amp stage: pedals before the amp, and the effects loop after the cabinet. */
type RackId = 'pre' | 'post'
const RACK_COLUMNS = 4
const isStage = (key: GuitarRigSlotKey) => { const { id } = parseRigSlot(key); return id === 'amp' || id === 'cabinet' }
/**
 * Splits the saved signal order into the editor's layout, which follows a real amp: pedals → preamp →
 * effects loop → speaker cabinet. Pedals before the amp are the pre rack; every pedal after the amp is in
 * the loop. Older racks that kept effects after the cabinet show them in the loop, and the next edit
 * stores them in front of the cabinet.
 */
function rigLayout(order: readonly GuitarRigSlotKey[]): { pre: GuitarRigSlotKey[]; post: GuitarRigSlotKey[]; stage: GuitarRigSlotKey[] } {
  const stage = order.filter(isStage).sort((a, b) => Number(parseRigSlot(a).id === 'cabinet') - Number(parseRigSlot(b).id === 'cabinet'))
  if (!stage.includes('amp')) stage.unshift('amp')
  if (!stage.includes('cabinet')) stage.push('cabinet')
  const amp = order.findIndex(key => parseRigSlot(key).id === 'amp')
  if (amp < 0) return { pre: order.filter(key => !isStage(key)), post: [], stage }
  return { pre: order.slice(0, amp).filter(key => !isStage(key)), post: order.slice(amp).filter(key => !isStage(key)), stage }
}
/** Pre rack → amp → effects loop → cabinet. */
const composeOrder = (pre: readonly GuitarRigSlotKey[], stage: readonly GuitarRigSlotKey[], post: readonly GuitarRigSlotKey[]) => {
  const cabinets = stage.filter(key => parseRigSlot(key).id === 'cabinet')
  return [...pre, ...stage.filter(key => !cabinets.includes(key)), ...post, ...cabinets]
}
const EFFECT_GROUPS: readonly { title: string; items: readonly GuitarRigModuleId[] }[] = [
  { title: '드라이브 · 다이내믹스', items: ['comp', 'drive', 'fuzz'] },
  { title: '모듈레이션', items: ['chorus', 'phaser', 'tremolo'] },
  { title: '공간계', items: ['delay', 'reverb'] },
  { title: '도구', items: ['tuner'] },
]
/** Where a newly added pedal goes when it is clicked rather than dragged: drive-type pedals before the amp, the rest in the loop. */
const DEFAULT_RACK: Record<GuitarRigModuleId, RackId> = { comp: 'pre', drive: 'pre', fuzz: 'pre', tuner: 'pre', chorus: 'post', phaser: 'post', tremolo: 'post', delay: 'post', reverb: 'post', amp: 'pre', cabinet: 'pre' }
const RACK_INFO: Record<RackId, { title: string; caption: string }> = {
  pre: { title: '프리 · PEDALS', caption: '앰프에 들어가기 전 소리를 만드는 페달' },
  post: { title: 'FX 루프 · LOOP', caption: '앰프와 스피커 사이에서 공간과 움직임을 더하는 장비' },
}

export function GuitarRigEditor({ device, track, audioState, onParam, onParams, onToggle, onTrackChange, onOpenAudioSettings, onClose }: EditorProps) {
  const titleId = useId(), hintId = useId(), inputStatusId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const shouldRestoreFocus = useRef(true)
  const latestClose = useRef(onClose); latestClose.current = onClose
  const params = device.params
  const preset = matchedPreset(params)
  const [userPresets, storeUserPresets] = useUserPresets()
  const userPreset = preset ? undefined : userPresets.find(item => sameParams(params, item.params))
  const [saving, setSaving] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const savePreset = (name: string) => {
    try {
      const result = putUserPreset(userPresets, name, params)
      if (!storeUserPresets(result.list)) { setAnnounce('프리셋을 저장하지 못했습니다. 저장 공간을 확인해 주세요.'); return }
      setSaving(null); setAnnounce(`'${result.preset.name}' 프리셋을 ${result.replaced ? '덮어썼습니다' : '저장했습니다'}.`)
    } catch (error) { setAnnounce(error instanceof Error ? error.message : String(error)) }
  }
  const deletePreset = (item: GuitarRigUserPreset) => { if (storeUserPresets(removeUserPreset(userPresets, item.id))) setAnnounce(`'${item.name}' 프리셋을 지웠습니다. 지금 소리는 그대로입니다.`); setConfirmDelete(false) }
  const order = guitarRigOrder(params)
  const layout = rigLayout(order)
  const racks: Record<RackId, GuitarRigSlotKey[]> = { pre: layout.pre, post: layout.post }
  const rackFull = (rack: RackId) => racks[rack].length >= GUITAR_RIG_RACK_CAPACITY
  const otherRack = (rack: RackId): RackId => rack === 'pre' ? 'post' : 'pre'
  /** A clicked pedal goes to its usual rack, or the other one when that is full. */
  const clickRack = (id: GuitarRigModuleId) => rackFull(DEFAULT_RACK[id]) ? otherRack(DEFAULT_RACK[id]) : DEFAULT_RACK[id]
  const [selected, setSelected] = useState<GuitarRigSlotKey | null>(null)
  const [dropAt, setDropAt] = useState<{ rack: RackId; index: number } | null>(null)
  const [dragging, setDragging] = useState<GuitarRigSlotKey | null>(null)
  const [addMenu, setAddMenu] = useState<RackId | null>(null)
  const [announce, setAnnounce] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; rack: RackId; key?: GuitarRigSlotKey } | null>(null)
  const monitoringOff = track.kind === 'audio' && audioState?.settings.softwareMonitoring === false
  const audioError = audioState?.error || (audioState?.status === 'error' ? '오디오 엔진을 시작하지 못했습니다.' : null)
  const audioNotReady = !!audioState?.needsReconfiguration
  const monitorBlocked = monitoringOff || !!audioError || audioNotReady
  const audioNotice = [
    audioError ? `오디오 오류: ${audioError} 오디오 설정에서 장치와 상태를 확인해 주세요.` : audioNotReady ? '오디오 설정을 다시 적용해야 합니다. 오디오 설정에서 장치와 상태를 확인해 주세요.' : '',
    monitoringOff ? '소프트웨어 모니터링이 꺼져 있습니다. 오디오 설정의 녹음·모니터링에서 켜 주세요.' : '',
  ].filter(Boolean).join(' ')

  const toggle = (id: string) => onParam(id, valueOf(params, id) >= .5 ? 0 : 1)
  const store = (next: Record<RackId, GuitarRigSlotKey[]>, extra: Record<string, number> = {}) => onParams({ ...guitarRigOrderParams(composeOrder(next.pre, layout.stage, next.post)), ...extra })
  const countOf = (id: GuitarRigModuleId) => order.filter(key => parseRigSlot(key).id === id).length
  const canAdd = (id: GuitarRigModuleId, rack: RackId = clickRack(id)) => !rackFull(rack) && countOf(id) < guitarRigMaxInstances(id)
  const refuse = (id: GuitarRigModuleId, rack: RackId = clickRack(id)) => setAnnounce(rackFull(rack) ? `${RACK_INFO[rack].title} 랙이 가득 찼습니다. 랙마다 최대 ${GUITAR_RIG_RACK_CAPACITY}개까지 꽂을 수 있습니다.` : `${baseTitle(id, params)}은(는) 최대 ${guitarRigMaxInstances(id)}대까지 꽂을 수 있습니다.`)
  /** Plug a new copy of `id` into `rack` at `index`, fresh or copied from an existing pedal. */
  const add = (id: GuitarRigModuleId, rack: RackId, index: number, copyFrom?: GuitarRigSlotKey) => {
    const key = nextRigInstance(order, id)
    if (!key || rackFull(rack)) { refuse(id, rack); return }
    const list = [...racks[rack]]; list.splice(Math.max(0, Math.min(list.length, index)), 0, key)
    store({ ...racks, [rack]: list }, copyFrom ? copiedModuleParams(copyFrom, key, params) : freshModuleParams(key))
    setSelected(key)
    setAnnounce(`${moduleTitle(key, params)}을(를) ${RACK_INFO[rack].title} ${index + 1}번 칸에 ${copyFrom ? '복제했습니다' : '꽂았습니다'}.`)
  }
  const place = (key: GuitarRigSlotKey, rack: RackId, index: number) => {
    const from: RackId = racks.pre.includes(key) ? 'pre' : 'post'
    if (from !== rack && rackFull(rack)) { refuse(parseRigSlot(key).id, rack); return }
    const fromIndex = racks[from].indexOf(key)
    const next = { pre: racks.pre.filter(item => item !== key), post: racks.post.filter(item => item !== key) }
    const at = from === rack && fromIndex < index ? index - 1 : index
    next[rack].splice(Math.max(0, Math.min(next[rack].length, at)), 0, key)
    if (composeOrder(next.pre, layout.stage, next.post).join() === order.join()) return
    store(next); setSelected(key)
    setAnnounce(`${moduleTitle(key, params)}을(를) ${RACK_INFO[rack].title} ${at + 1}번 칸으로 옮겼습니다.`)
  }
  /** Swap a pedal for a fresh copy of another effect in the same slot. */
  const replace = (key: GuitarRigSlotKey, id: GuitarRigModuleId) => {
    const next = nextRigInstance(order, id)
    if (!next) { refuse(id); return }
    const swap = (list: GuitarRigSlotKey[]) => list.map(item => item === key ? next : item)
    store({ pre: swap(racks.pre), post: swap(racks.post) }, freshModuleParams(next))
    setSelected(next)
    setAnnounce(`${moduleTitle(key, params)}을(를) ${baseTitle(id, params)}(으)로 바꿨습니다.`)
  }
  const resetPedal = (key: GuitarRigSlotKey) => { onParams(freshModuleParams(key)); setAnnounce(`${moduleTitle(key, params)} 설정을 초기화했습니다.`) }
  const pedalMenu = (key: GuitarRigSlotKey, rack: RackId): ContextMenuItem[] => {
    const { id, instance } = parseRigSlot(key)
    const index = racks[rack].indexOf(key), other = otherRack(rack)
    const enabled = valueOf(params, rigParam(MODULE_ENABLED[id], instance)) >= .5
    return [
      { label: enabled ? '바이패스' : '켜기', icon: 'power', onSelect: () => toggle(rigParam(MODULE_ENABLED[id], instance)) },
      { label: '복제', icon: 'copy', disabled: !canAdd(id, rack), onSelect: () => add(id, rack, index + 1, key) },
      { label: '다른 이펙터로 바꾸기', icon: 'refresh', items: EFFECT_GROUPS.flatMap(group => group.items).map(item => ({ label: baseTitle(item, params), checked: item === id, disabled: item === id || countOf(item) >= guitarRigMaxInstances(item), onSelect: () => replace(key, item) })) },
      { type: 'separator' },
      { label: '앞으로', icon: 'left', disabled: index === 0, onSelect: () => place(key, rack, index - 1) },
      { label: '뒤로', icon: 'right', disabled: index === racks[rack].length - 1, onSelect: () => place(key, rack, index + 2) },
      { label: other === 'pre' ? '프리 랙으로 옮기기' : 'FX 루프로 옮기기', icon: other === 'pre' ? 'up' : 'down', disabled: rackFull(other), onSelect: () => place(key, other, racks[other].length) },
      { label: '설정 초기화', icon: 'undo', onSelect: () => resetPedal(key) },
      { type: 'separator' },
      { label: '빼기', icon: 'trash', danger: true, shortcut: '더블 클릭', onSelect: () => remove(key) },
    ]
  }
  const rackMenu = (rack: RackId): ContextMenuItem[] => [
    { label: '이펙터 꽂기', icon: 'plus', disabled: rackFull(rack), items: EFFECT_GROUPS.flatMap(group => group.items).map(id => ({ label: baseTitle(id, params), disabled: !canAdd(id, rack), onSelect: () => add(id, rack, racks[rack].length) })) },
    { label: '이 랙 비우기', icon: 'trash', danger: true, disabled: racks[rack].length === 0, onSelect: () => { store({ ...racks, [rack]: [] }); setAnnounce(`${RACK_INFO[rack].title} 랙을 비웠습니다.`) } },
  ]
  const remove = (key: GuitarRigSlotKey) => { store({ pre: racks.pre.filter(item => item !== key), post: racks.post.filter(item => item !== key) }); setAnnounce(`${moduleTitle(key, params)}을(를) 랙에서 뺐습니다.`) }

  const dragStart = (event: React.DragEvent, payload: DragPayload) => {
    event.dataTransfer.setData(DRAG_TYPE, encodeDrag(payload)); event.dataTransfer.effectAllowed = payload.kind === 'new' ? 'copy' : 'move'
    if (payload.kind === 'move') setTimeout(() => setDragging(payload.key))
  }
  const dragEnd = () => { setDropAt(null); setDragging(null) }
  const dragOver = (event: React.DragEvent, rack: RackId, index: number) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === 'copy' ? 'copy' : 'move'
    if (dropAt?.rack !== rack || dropAt.index !== index) setDropAt({ rack, index })
  }
  const drop = (event: React.DragEvent, rack: RackId, index: number) => {
    const payload = decodeDrag(event.dataTransfer.getData(DRAG_TYPE))
    dragEnd()
    if (!payload) return
    event.preventDefault(); event.stopPropagation()
    if (payload.kind === 'new') add(payload.id, rack, index); else place(payload.key, rack, index)
  }
  /** Over a pedal, the drop lands before or after it depending on which half the pointer is in. */
  const halfIndex = (event: React.DragEvent, index: number) => { const box = event.currentTarget.getBoundingClientRect(); return event.clientX < box.left + box.width / 2 ? index : index + 1 }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.focus({ preventScroll: true })
    const focusInside = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('.context-menu')) return
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', focusInside)
    return () => {
      document.removeEventListener('focusin', focusInside)
      document.body.style.overflow = overflow
      if (shouldRestoreFocus.current && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const settings = () => { shouldRestoreFocus.current = false; onClose(); onOpenAudioSettings?.() }
  function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (addMenu !== null) { event.preventDefault(); event.stopPropagation(); setAddMenu(null); return }
      event.preventDefault(); event.stopPropagation(); latestClose.current(); return
    }
    if (event.key === 'Tab') {
      const dialog = dialogRef.current!
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items.at(-1), active = document.activeElement
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (active === last || active === dialog)) { event.preventDefault(); first.focus() }
      event.stopPropagation(); return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault(); event.stopPropagation(); if (onOpenAudioSettings) settings(); return
    }
    // Keep the application's undo/redo and save commands available in this editor.
    if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) return
    event.stopPropagation()
  }

  const ampKey = layout.stage.find(key => parseRigSlot(key).id === 'amp') ?? 'amp'
  const cabKey = layout.stage.find(key => parseRigSlot(key).id === 'cabinet') ?? 'cabinet'
  const ampOn = valueOf(params, rigParam('ampEnabled', parseRigSlot(ampKey).instance)) >= .5
  const cabOn = valueOf(params, rigParam('cabinetEnabled', parseRigSlot(cabKey).instance)) >= .5
  const ampPk = (base: string) => rigParam(base, parseRigSlot(ampKey).instance)
  const cabPk = (base: string) => rigParam(base, parseRigSlot(cabKey).instance)
  let slotNumber = 0
  const rackView = (rack: RackId) => {
    const list = racks[rack]
    const start = rack === 'pre' ? 0 : layout.pre.length
    const full = rackFull(rack)
    const rowFull = list.length > 0 && list.length % RACK_COLUMNS === 0
    const cells = Math.max(RACK_COLUMNS, Math.ceil(list.length / RACK_COLUMNS) * RACK_COLUMNS)
    const marker = (index: number) => dropAt?.rack === rack && dropAt.index === index
    return <section className="gr-fxrack" data-rack={rack} aria-label={`${RACK_INFO[rack].title} 랙: ${RACK_INFO[rack].caption}`} onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, rack }) }} onDragOver={event => dragOver(event, rack, list.length)} onDrop={event => drop(event, rack, list.length)}>
      <header className="gr-fxrack-head" title={RACK_INFO[rack].caption}><h3>{RACK_INFO[rack].title}</h3><span>{list.length}/{GUITAR_RIG_RACK_CAPACITY}</span></header>
      {rowFull && !full && <button className="gr-fxrack-add" aria-label={`${RACK_INFO[rack].title}에 이펙터 꽂기`} title="이펙터 꽂기" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom + 4, rack }) }}><Icon name="plus" size={12}/></button>}
      <div className="gr-fxrack-bay">
      <div className="gr-fxrack-grid">
        {Array.from({ length: cells }, (_, index) => {
          const key = list[index]
          if (key) {
            slotNumber = start + index + 1
            return <PedalSlot key={key} slot={parseRigSlot(key)} number={slotNumber} deviceId={device.id} params={params} onParam={onParam}
              selected={key === selected} dragging={key === dragging} dropBefore={marker(index)} dropAfter={index === list.length - 1 && marker(index + 1)}
              onSelect={() => setSelected(key)} onToggle={() => toggle(rigParam(MODULE_ENABLED[parseRigSlot(key).id], parseRigSlot(key).instance))}
              onRemove={() => remove(key)} onMenu={event => setMenu({ x: event.clientX, y: event.clientY, rack, key })}
              onDragStart={event => dragStart(event, { kind: 'move', key })} onDragEnd={dragEnd}
              onDragOver={event => dragOver(event, rack, halfIndex(event, index))} onDrop={event => drop(event, rack, halfIndex(event, index))}/>
          }
          const shortRow = Math.floor(index / RACK_COLUMNS) * RACK_COLUMNS >= list.length && list.length > 0
          if (index === list.length && !full && !rowFull) return <div key="add" className="gr-slot-empty gr-slot-add" data-drop={marker(index)} data-short={shortRow}>
            <button aria-label={`${RACK_INFO[rack].title}에 이펙터 꽂기`} aria-expanded={addMenu === rack} onClick={() => setAddMenu(addMenu === rack ? null : rack)}><Icon name="plus" size={22}/><span>이펙터 꽂기</span></button>
            {addMenu === rack && <div className="gr-insert-menu" role="menu">{EFFECT_GROUPS.flatMap(group => group.items).map(id => <button key={id} role="menuitem" disabled={!canAdd(id, rack)} onClick={() => { setAddMenu(null); add(id, rack, list.length) }}><img src={moduleThumb(id, params)} alt="" width={40} height={30}/><span>{baseTitle(id, params)}<small>{MODULE_KIND[id]}{countOf(id) ? ` · ${countOf(id)}대 사용 중` : ''}</small></span></button>)}</div>}
          </div>
          return <div key={`blank-${index}`} className="gr-slot-gap" data-short={shortRow} aria-hidden="true"/>
        })}
      </div>
      </div>
    </section>
  }

  return createPortal(<div className="gr-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !document.querySelector('[data-daw-gesture]')) onClose() }}>
    <section ref={dialogRef} className="gr-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} tabIndex={-1} data-guitar-rig-dialog="" onKeyDown={keyDown}>
      <header className="gr-header"><div className="gr-heading"><span className="gr-eyebrow">GARAKIEUM · GUITAR WORKSHOP</span><h2 id={titleId}>기타 앰프</h2><p>{track.name}</p></div>
        <div className="gr-header-actions"><button className={`gr-power${device.enabled ? ' is-on' : ''}`} onClick={onToggle} aria-pressed={device.enabled}><Icon name="power" size={15}/>{device.enabled ? '앰프 시스템 켜짐' : '전체 바이패스'}</button><button className="gr-close" onClick={onClose} aria-label="기타 앰프 편집기 닫기"><Icon name="close" size={20}/></button></div>
      </header>
      <div className="gr-toolbar"><span className="gr-preset-label">PRESET</span><RigPresetPicker value={preset?.id ?? (userPreset ? `user:${userPreset.id}` : 'custom')} placeholder="나만의 톤 · 저장 안 됨"
          groups={[
            { label: '기본 프리셋', options: GUITAR_RIG_PRESETS.map(item => ({ value: item.id, name: item.name, detail: item.description })) },
            { label: '내 프리셋', options: userPresets.map(item => ({ value: `user:${item.id}`, name: item.name, detail: `${new Date(item.savedAt).toLocaleDateString('ko-KR')} 저장` })), empty: '아직 저장한 프리셋이 없습니다.' },
          ]}
          onSelect={value => {
            setConfirmDelete(false)
            const next = value.startsWith('user:') ? userPresets.find(item => `user:${item.id}` === value)?.params : GUITAR_RIG_PRESETS.find(item => item.id === value)?.params
            if (next) onParams({ ...next })
          }}
          onSaveCurrent={() => { setConfirmDelete(false); setSaving(userPreset?.name ?? '') }}/>
        {saving === null ? <>
          <button className="gr-preset-save" onClick={() => { setConfirmDelete(false); setSaving(userPreset?.name ?? '') }} title="지금 톤을 내 프리셋으로 저장"><Icon name="save" size={13}/>{userPreset ? '다시 저장' : '프리셋 저장'}</button>
          {userPreset && (confirmDelete
            ? <span className="gr-preset-confirm"><span>'{userPreset.name}' 지울까요?</span><button className="gr-preset-danger" onClick={() => deletePreset(userPreset)}>지우기</button><button onClick={() => setConfirmDelete(false)}>취소</button></span>
            : <button className="gr-preset-delete" onClick={() => setConfirmDelete(true)} aria-label={`내 프리셋 ${userPreset.name} 지우기`} title="이 프리셋 지우기"><Icon name="trash" size={13}/></button>)}
        </> : <form className="gr-preset-form" onSubmit={event => { event.preventDefault(); savePreset(saving) }}>
          <input autoFocus value={saving} maxLength={MAX_PRESET_NAME} placeholder="프리셋 이름" aria-label="저장할 프리셋 이름" onChange={event => setSaving(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSaving(null) } }}/>
          <button type="submit" disabled={!saving.trim()}>{userPresets.some(item => item.name.toLocaleLowerCase() === saving.trim().replace(/\s+/g, ' ').toLocaleLowerCase()) ? '덮어쓰기' : '저장'}</button>
          <button type="button" onClick={() => setSaving(null)}>취소</button>
        </form>}
        {track.kind === 'audio' && <button className={`gr-monitor${track.monitor && !monitorBlocked ? ' is-on' : ''}`} aria-pressed={track.monitor} aria-describedby={audioNotice?inputStatusId:undefined} onClick={() => onTrackChange({ monitor: !track.monitor })}><Icon name="headphones" size={14}/>입력 모니터 {track.monitor ? monitorBlocked ? '대기' : '켬' : '끔'}</button>}{onOpenAudioSettings && <button className="gr-settings" onClick={settings}><Icon name="settings" size={14}/>오디오 설정</button>}
        <button className="gr-reset" onClick={() => onParams({ ...GUITAR_RIG_PRESETS[0].params })}><Icon name="refresh" size={13}/>초기 톤</button></div>
      {audioNotice && <p id={inputStatusId} className="gr-audio-notice" role="status"><Icon name="info" size={14}/><span>{audioNotice}</span></p>}
      <div className="gr-workspace">
        <aside className="gr-browser" aria-label="이펙터 목록">
          <h3>이펙터</h3>
          <p className="gr-browser-hint">랙의 칸으로 끌어다 꽂거나, 눌러서 알맞은 랙의 끝에 꽂습니다. 같은 이펙터도 여러 대 꽂을 수 있습니다.</p>
          {EFFECT_GROUPS.map(group => <div className="gr-browser-group" key={group.title}><h4>{group.title}</h4>
            {group.items.map(id => { const count = countOf(id), addable = canAdd(id); return <button key={id} className="gr-browser-item" draggable={addable} aria-disabled={!addable} onDragStart={event => dragStart(event, { kind: 'new', id })} onDragEnd={dragEnd} onClick={() => addable ? add(id, clickRack(id), racks[clickRack(id)].length) : refuse(id)} aria-label={`${baseTitle(id, params)} ${RACK_INFO[clickRack(id)].title} 랙에 꽂기${count ? `, ${count}대 사용 중` : ''}`}>
              <img src={moduleThumb(id, params)} alt="" width={44} height={40} draggable={false}/><span><strong>{baseTitle(id, params)}</strong><small>{MODULE_KIND[id]}</small></span>
              {count > 0 && <em className="gr-browser-count" aria-hidden="true">×{count}</em>}<i className="gr-browser-plus" aria-hidden="true"><Icon name="plus" size={11}/></i>
            </button> })}
          </div>)}
        </aside>
        <div className="gr-rig-scroll">
          <ol className="gr-flow" aria-label="신호 흐름">
            <li>INPUT</li><li data-on={layout.pre.length > 0}>프리 {layout.pre.length}</li><li data-on={ampOn}>{shortLabel(params, ampPk('ampModel'))}</li><li data-on={layout.post.length > 0}>FX 루프 {layout.post.length}</li><li data-on={cabOn}>{shortLabel(params, cabPk('cabinet'))}</li><li>OUTPUT</li>
          </ol>
          <div className="gr-rig-column">
          <RigCables layoutKey={`${order.join()}|${racks.pre.length % RACK_COLUMNS}|${valueOf(params, ampPk('ampModel'))}|${valueOf(params, cabPk('cabinet'))}`}/>
          {rackView('pre')}
          <section className="gr-stage gr-stage-amp" aria-label="앰프" data-bypassed={!ampOn}>
            <header className="gr-stage-head"><h3>AMP</h3><RigChoice id={ampPk('ampModel')} label="모델" params={params} onParam={onParam}/></header>
            <AmpFace pk={ampPk} params={params} onParam={onParam} onToggle={() => toggle(ampPk('ampEnabled'))} enabled={ampOn}/>
          </section>
          {rackView('post')}
          <section className="gr-stage gr-stage-cab" aria-label="캐비닛 · 마이크" data-bypassed={!cabOn}>
            <header className="gr-stage-head"><button className="gr-unit-power" aria-pressed={cabOn} aria-label={`캐비닛 ${cabOn ? '켜짐, 누르면 바이패스' : '바이패스, 누르면 켜기'}`} title={cabOn ? '캐비닛 켜짐 · 누르면 바이패스' : '캐비닛 바이패스 · 누르면 켜기'} onClick={() => toggle(cabPk('cabinetEnabled'))}><i aria-hidden="true"/><span className="gr-unit-power-switch" aria-hidden="true"><span/></span><small aria-hidden="true">{cabOn ? 'ON' : 'BYPASS'}</small></button><h3>CABINET</h3><RigChoice id={cabPk('cabinet')} label="모델" params={params} onParam={onParam}/></header>
            <CabinetFace pk={cabPk} params={params} onParam={onParam}/>
          </section>
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.key ? `${moduleTitle(menu.key, params)} 메뉴` : `${RACK_INFO[menu.rack].title} 랙 메뉴`} items={menu.key ? pedalMenu(menu.key, menu.rack) : rackMenu(menu.rack)} onClose={() => setMenu(null)}/>}
      <p className="gr-sr-only" role="status" aria-live="polite">{announce}</p>
      <footer className="gr-footer"><p id={hintId}>{GUITAR_RIG_SOUND_DESCRIPTION} · 입력 → 프리 페달 → 앰프 → FX 루프 → 캐비닛 → 출력</p><p><kbd>Shift</kbd> 미세 조절 · 더블 클릭 초기값 · <kbd>Esc</kbd> 닫기</p></footer>
    </section>
  </div>, document.body)
}

const MODULE_KIND: Record<GuitarRigModuleId, string> = { comp: '컴프레서', drive: '오버드라이브', amp: '앰프 헤드', cabinet: '캐비닛 · 마이크', chorus: '코러스', delay: '딜레이', fuzz: '퍼즈', phaser: '페이저', tremolo: '트레몰로', reverb: '리버브', tuner: '튜너' }
function baseTitle(id: GuitarRigModuleId, params: Record<string, number>): string {
  if (id === 'amp') return shortLabel(params, 'ampModel')
  if (id === 'cabinet') return shortLabel(params, 'cabinet')
  return PEDAL_META[id].name
}
function moduleTitle(key: GuitarRigSlotKey, params: Record<string, number>): string {
  const { id, instance } = parseRigSlot(key)
  if (id === 'amp') return shortLabel(params, rigParam('ampModel', instance))
  if (id === 'cabinet') return shortLabel(params, rigParam('cabinet', instance))
  return PEDAL_META[id].name + (instance ? ` ${instance + 1}` : '')
}
function moduleThumb(id: GuitarRigModuleId, params: Record<string, number>): string {
  if (id === 'amp') return (AMPS[Math.round(valueOf(params, 'ampModel'))] ?? AMPS[0]).image
  if (id === 'cabinet') return (CABINETS[Math.round(valueOf(params, 'cabinet'))] ?? CABINETS[1]).image
  return PEDAL_META[id].image
}

/**
 * Rig patch cables, drawn as one SVG layer over the whole column so every cord follows the same rules:
 * right-angle plugs on the pedals' side jacks, a short tidy loop between neighbours, and square runs with
 * rounded bends through the gaps between rows and parts (pre rack → amp INPUT, amp SEND → loop rack →
 * cabinet). Pure decoration: it never takes pointer events.
 */
interface Plug { x: number; y: number; side: 1 | -1; dir: 1 | -1 }
/** Plug geometry: the barrel reaches PLUG_REACH out of the jack, the body runs PLUG_DROP up or down. */
const PLUG_REACH = 9, PLUG_DROP = 15, BEND = 9
const plugTail = (plug: Plug): [number, number] => [plug.x + plug.side * PLUG_REACH, plug.y + plug.dir * PLUG_DROP]
/** A path through square corners, each corner rounded by up to BEND. */
function squarePath(points: readonly [number, number][]): string {
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1]
    const inLen = Math.hypot(x - px, y - py), outLen = Math.hypot(nx - x, ny - y)
    const r = Math.min(BEND, inLen / 2, outLen / 2)
    if (r < .5) { d += ` L${x} ${y}`; continue }
    d += ` L${x - (x - px) / inLen * r} ${y - (y - py) / inLen * r} Q${x} ${y} ${x + (nx - x) / outLen * r} ${y + (ny - y) / outLen * r}`
  }
  const last = points.at(-1)!
  return `${d} L${last[0]} ${last[1]}`
}
interface PedalBox { left: number; right: number; y: number; top: number; bottom: number }
function RigCables({ layoutKey }: { layoutKey: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [scene, setScene] = useState<{ cords: string[]; plugs: Plug[]; rings: [number, number][] }>({ cords: [], plugs: [], rings: [] })
  const [size, setSize] = useState<[number, number]>([0, 0])
  useLayoutEffect(() => {
    // The column is this SVG's parent. (A parent's ref is not attached yet when a child's layout effect runs.)
    const column = svgRef.current?.parentElement
    if (!column) return
    const measure = () => {
      const box = column.getBoundingClientRect()
      const rel = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top, cx: r.left + r.width / 2 - box.left, cy: r.top + r.height / 2 - box.top } }
      const pedalsOf = (rack: RackId): PedalBox[] => [...column.querySelectorAll<HTMLElement>(`[data-rack="${rack}"] .gr-slot .gr-pedal-stage`)].map(el => {
        const r = rel(el)!, w = r.right - r.left, h = r.bottom - r.top
        // The art has a transparent margin around the body (25/360 wide, 22/600 tall): jacks sit on the body's sides.
        return { left: r.left + w * 25 / 360, right: r.right - w * 25 / 360, y: r.top + h * .3, top: r.top + h * 22 / 600, bottom: r.bottom - h * 22 / 600 }
      })
      const cords: string[] = [], plugs: Plug[] = [], rings: [number, number][] = []
      const link = (from: Plug, to: Plug, path: [number, number][]) => { plugs.push(from, to); cords.push(squarePath([plugTail(from), ...path, plugTail(to)])) }
      const sameRow = (a: PedalBox, b: PedalBox) => Math.abs(a.y - b.y) < 4
      const chain = (pedals: PedalBox[]) => {
        for (let i = 0; i + 1 < pedals.length; i++) {
          const a = pedals[i], b = pedals[i + 1]
          if (sameRow(a, b)) {
            // Neighbours: both plugs point down and the cord hangs in a short, even loop.
            const from: Plug = { x: a.right, y: a.y, side: 1, dir: 1 }, to: Plug = { x: b.left, y: b.y, side: -1, dir: 1 }
            const [ax, ay] = plugTail(from), [bx, by] = plugTail(to), dip = Math.min(22, 10 + Math.abs(bx - ax) * .25)
            plugs.push(from, to)
            cords.push(`M${ax} ${ay} C${ax} ${ay + dip} ${bx} ${by + dip} ${bx} ${by}`)
          } else {
            // Next row: down out of the last pedal, along the gap between the rows, down into the next pedal.
            const gap = (a.bottom + b.top) / 2
            const from: Plug = { x: a.right, y: a.y, side: 1, dir: 1 }, to: Plug = { x: b.left, y: b.y, side: -1, dir: -1 }
            link(from, to, [[plugTail(from)[0], gap], [plugTail(to)[0], gap]])
          }
        }
      }
      const pre = pedalsOf('pre'), post = pedalsOf('post')
      chain(pre); chain(post)
      const preRack = rel(column.querySelector('[data-rack="pre"]')), postRack = rel(column.querySelector('[data-rack="post"]'))
      const amp = rel(column.querySelector('.gr-stage-amp')), cab = rel(column.querySelector('.gr-stage-cab'))
      const ampIn = rel(column.querySelector('[data-anchor="amp-in"]')), ampOut = rel(column.querySelector('[data-anchor="amp-out"]')), cabIn = rel(column.querySelector('[data-anchor="cab-in"]'))
      const gutterLeft = -20, gutterRight = box.width + 20
      // Front-panel jacks (amp, cabinet) are seen face-on: the cord ends in a chrome ring there.
      if (pre.length && preRack && amp && ampIn) {
        const last = pre.at(-1)!, from: Plug = { x: last.right, y: last.y, side: 1, dir: 1 }, [tx] = plugTail(from), gap = (preRack.bottom + amp.top) / 2
        plugs.push(from); rings.push([ampIn.cx, ampIn.cy])
        cords.push(squarePath([plugTail(from), [tx, gap], [gutterLeft, gap], [gutterLeft, ampIn.cy], [ampIn.cx, ampIn.cy]]))
      }
      if (ampOut && amp && postRack && post.length) {
        const first = post[0], to: Plug = { x: first.left, y: first.y, side: -1, dir: -1 }, [tx, ty] = plugTail(to), gap = (amp.bottom + postRack.top) / 2
        plugs.push(to); rings.push([ampOut.cx, ampOut.cy])
        cords.push(squarePath([[ampOut.cx, ampOut.cy], [gutterRight, ampOut.cy], [gutterRight, gap], [tx, gap], [tx, ty]]))
      }
      if (cabIn && cab && postRack) {
        const gap = (postRack.bottom + cab.top) / 2
        rings.push([cabIn.cx, cabIn.cy])
        if (post.length) {
          const last = post.at(-1)!, from: Plug = { x: last.right, y: last.y, side: 1, dir: 1 }, [tx] = plugTail(from)
          plugs.push(from)
          cords.push(squarePath([plugTail(from), [tx, gap], [cabIn.cx, gap], [cabIn.cx, cabIn.cy]]))
        } else if (ampOut) {
          // Empty loop: the amp's send goes straight to the cabinet, down the right-hand margin.
          rings.push([ampOut.cx, ampOut.cy])
          cords.push(squarePath([[ampOut.cx, ampOut.cy], [gutterRight, ampOut.cy], [gutterRight, gap], [cabIn.cx, gap], [cabIn.cx, cabIn.cy]]))
        }
      }
      setScene({ cords, plugs, rings })
      setSize([box.width, box.height])
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [layoutKey])
  const plug = (jack: Plug, key: string) => <g key={key} transform={`translate(${jack.x} ${jack.y}) scale(${jack.side} ${jack.dir})`}>
    <rect x={0} y={-2.5} width={PLUG_REACH} height={5} rx={1.2} fill="url(#gr-barrel)" stroke="#0008" strokeWidth={.5}/>
    <rect x={PLUG_REACH - 4.5} y={-4.5} width={9} height={PLUG_DROP - 1} rx={2.5} fill="url(#gr-plugbody)" stroke="#0009" strokeWidth={.6}/>
    <rect x={PLUG_REACH - 3.2} y={PLUG_DROP - 7} width={6.4} height={7} rx={1.6} fill="#161717"/>
  </g>
  return <svg ref={svgRef} className="gr-rig-cables" width={size[0]} height={size[1]} aria-hidden="true">
    <defs>
      <linearGradient id="gr-barrel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff"/><stop offset=".45" stopColor="#b5bab5"/><stop offset=".6" stopColor="#7d837e"/><stop offset="1" stopColor="#d8dbd7"/></linearGradient>
      <linearGradient id="gr-plugbody" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8a908b"/><stop offset=".3" stopColor="#f4f5f3"/><stop offset=".55" stopColor="#b9beb9"/><stop offset="1" stopColor="#5c625d"/></linearGradient>
      <radialGradient id="gr-nut" cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#f7f8f6"/><stop offset=".6" stopColor="#9aa09b"/><stop offset="1" stopColor="#3f4440"/></radialGradient>
      <filter id="gr-cable-shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="1" dy="3" stdDeviation="2" floodColor="#000" floodOpacity=".55"/></filter>
    </defs>
    <g filter="url(#gr-cable-shadow)">
      {scene.cords.map((d, i) => <g key={i}><path d={d} className="gr-cable-cord"/><path d={d} className="gr-cable-core"/><path d={d} className="gr-cable-sheen"/></g>)}
      {scene.plugs.map((jack, i) => plug(jack, `p${i}`))}
      {scene.rings.map(([x, y], i) => <circle key={`r${i}`} cx={x} cy={y} r={5.5} fill="url(#gr-nut)" stroke="#111" strokeWidth={.8}/>)}
    </g>
  </svg>
}

interface PedalSlotProps {
  slot: GuitarRigSlot; number: number; deviceId: string; params: Record<string, number>
  selected: boolean; dragging: boolean; dropBefore: boolean; dropAfter: boolean
  onParam: (key: string, value: number) => void; onSelect(): void; onToggle(): void; onRemove(): void; onMenu(event: React.MouseEvent): void
  onDragStart(event: React.DragEvent): void; onDragEnd(): void; onDragOver(event: React.DragEvent): void; onDrop(event: React.DragEvent): void
}

/** Controls on a pedal keep their own double-click (knob reset) and clicks. */
const PEDAL_CONTROLS = '.gr-placed-knob,.gr-footswitch,button,[role=slider],input,select'

/**
 * One rack slot: a small centred name above the pedal, and the pedal itself with knobs and footswitch on its art.
 * Right-click opens the slot menu; double-clicking the pedal (not a control) removes it.
 */
function PedalSlot({ slot, number, deviceId, params, selected, dragging, dropBefore, dropAfter, onParam, onSelect, onToggle, onRemove, onMenu, onDragStart, onDragEnd, onDragOver, onDrop }: PedalSlotProps) {
  const { id, instance, key } = slot
  const pk = (base: string) => rigParam(base, instance)
  const enabled = valueOf(params, pk(MODULE_ENABLED[id])) >= .5
  const title = moduleTitle(key, params)
  const meta = PEDAL_META[id as keyof typeof PEDAL_META]
  const section = GUITAR_RIG_SECTIONS.find(item => item.id === id)!
  return <article id={`gr-slot-${key}`} className="gr-slot" data-module={id} data-bypassed={!enabled} data-selected={selected} data-dragging={dragging} data-drop-before={dropBefore} data-drop-after={dropAfter}
    aria-label={`${number}번 칸 ${title} ${MODULE_KIND[id]}${enabled ? '' : ', 바이패스'}. 오른쪽 클릭으로 메뉴, 더블 클릭으로 빼기`} onPointerDown={onSelect} onDragOver={onDragOver} onDrop={onDrop}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onSelect(); onMenu(event) }}
    onDoubleClick={event => { if (!(event.target as HTMLElement).closest(PEDAL_CONTROLS)) { event.preventDefault(); onRemove() } }}>
    <h4 className="gr-slot-title" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} title="끌어서 다른 칸으로 옮기기 · 오른쪽 클릭 메뉴 · 더블 클릭으로 빼기">{title}</h4>
    <div className="gr-slot-bay">
      {id === 'tuner' ? <TunerPedal deviceId={deviceId} onToggle={onToggle} enabled={enabled}/> :
        <div className={`gr-pedal-stage gr-pedal-${id}`} data-bypassed={!enabled}>
          <img className="gr-pedal-art" src={meta.image} alt="" width={360} height={600} draggable={false}/><span className="gr-port gr-port-in" aria-hidden="true"/><span className="gr-port gr-port-out" aria-hidden="true"/>
          {section.params.map((base, index) => <div className="gr-placed-knob" key={base} style={{ left: PEDAL_POINTS[index][0], top: PEDAL_POINTS[index][1] }}><RigKnob id={pk(base)} base={base} label={meta.labels[index]} section={title} params={params} onParam={onParam} knob={meta.knob}/></div>)}
          <span className="gr-pedal-led" data-on={enabled} aria-hidden="true"/><button className="gr-footswitch" aria-label={`${title} 페달 켜기/바이패스`} aria-pressed={enabled} title={`${title} ${enabled ? '켜짐' : '바이패스'}`} onClick={onToggle}/>
        </div>}
    </div>
  </article>
}

type ParamKey = (base: string) => string


/**
 * Long, low amp heads drawn in CSS for the vertical rig layout. A head has no speaker (the cabinet below
 * is the speaker): tolex body with piping, a vented front with a metal emblem, and a full-width control
 * panel. Indexed by the saved `ampModel` value; finishes echo each model's artwork.
 */
const AMP_HEADS = [
  { tolex: '#191a1a', piping: '#d8d1bb', panel: 'silver', emblem: 'bar', jewel: '#ff4836' },   // Twinline '65
  { tolex: '#141414', piping: '#cfb47a', panel: 'gold', emblem: 'diamond', jewel: '#ff4836' }, // Plexton 59
  { tolex: '#4a2c1c', piping: '#b88a57', panel: 'black', emblem: 'jar', jewel: '#ff7a2a' },    // 옹기 Lead
  { tolex: '#2a1712', piping: '#e5d6b0', panel: 'copper', emblem: 'shield', jewel: '#ffcf3a' }, // Topboost 30
  { tolex: '#6f9a88', piping: '#efe6cc', panel: 'cream', emblem: 'cloud', jewel: '#7dff9a' },  // 청자 Jazz
] as const

function AmpFace({ pk, params, onParam, onToggle, enabled }: { pk: ParamKey; params: Record<string, number>; onParam: (key: string, value: number) => void; onToggle(): void; enabled: boolean }) {
  const model = Math.round(valueOf(params, pk('ampModel')))
  const head = AMP_HEADS[model] ?? AMP_HEADS[0]
  return <div className="gr-amphead" data-panel={head.panel} data-emblem={head.emblem} data-bypassed={!enabled}
    style={{ '--tolex': head.tolex, '--piping': head.piping, '--jewel': head.jewel } as React.CSSProperties} role="group" aria-label={`${shortLabel(params, pk('ampModel'))} 앰프 헤드`}>
    <span className="gr-amphead-handle" aria-hidden="true"/>
    {['tl', 'tr', 'bl', 'br'].map(pos => <i key={pos} className="gr-amphead-corner" data-pos={pos} aria-hidden="true"/>)}
    <div className="gr-amphead-front" aria-hidden="true"><span className="gr-amphead-vents"/><span className="gr-amphead-emblem"/><span className="gr-amphead-vents"/></div>
    <div className="gr-amphead-panel">
      <span className="gr-amphead-jack" aria-hidden="true"><i data-anchor="amp-in"/><small>INPUT</small></span>
      <div className="gr-amphead-knobs">{AMP_IDS.map((base, index) => <RigKnob key={base} id={pk(base)} base={base} label={AMP_LABELS[index]} section="앰프" params={params} onParam={onParam} knob={AMP_KNOBS[model] ?? 'cream'} size={50}/>)}</div>
      <div className="gr-amphead-power">
        <span className="gr-amphead-jewel" data-on={enabled} aria-hidden="true"/>
        <button className="gr-amphead-toggle" aria-pressed={enabled} aria-label={`앰프 ${enabled ? '켜짐, 누르면 바이패스' : '바이패스, 누르면 켜기'}`} onClick={onToggle}><span/></button>
        <small aria-hidden="true">{enabled ? 'ON' : 'STANDBY'}</small>
      </div>
      <span className="gr-amphead-jack" aria-hidden="true"><i data-anchor="amp-out"/><small>SEND</small></span>
    </div>
  </div>
}

function CabinetFace({ pk, params, onParam }: { pk: ParamKey; params: Record<string, number>; onParam: (key: string, value: number) => void }) {
  const cab = CABINETS[Math.round(valueOf(params, pk('cabinet')))] ?? CABINETS[1]
  const [cx, cy] = cab.speaker, reach = Math.round(cab.radius * .87)
  const position = pk('micPosition'), distance = pk('micDistance')
  return <div className="gr-cab-face">
    <div className="gr-cabinet-stage"><i className="gr-cab-jack" data-anchor="cab-in" aria-hidden="true"/><img src={cab.image} alt={cab.alt} width={768} height={512} draggable={false}/><svg className="gr-mic-overlay" viewBox="0 0 768 512" aria-hidden="true"><path className="gr-mic-guide" d={`M${cx} ${cy}H${cx + reach}`}/><circle className="gr-mic-center" cx={cx} cy={cy} r={3}/><g transform={`translate(${cx + valueOf(params, position) * reach} ${cy})`} className="gr-mic-marker"><circle r={18}/><path d="M-25 0H-8M8 0H25M0 -25V-8M0 8V25"/><text x={0} y={-32} textAnchor="middle">MIC</text></g></svg></div>
    <div className="gr-cab-controls">
      <div className="gr-mic-pick"><img className="gr-mic-photo" src={MICS[Math.round(valueOf(params, pk('micType')))] ?? MICS[0]} alt={`${shortLabel(params, pk('micType'))} 마이크`} width={480} height={360} draggable={false}/><RigChoice id={pk('micType')} label="마이크" params={params} onParam={onParam}/></div>
      <RigRange def={PARAMS.get(position)!} value={valueOf(params, position)} onChange={value => onParam(position, value)} left="스피커 중앙 · 밝게" right="가장자리 · 부드럽게"/>
      <RigRange def={PARAMS.get(distance)!} value={valueOf(params, distance)} onChange={value => onParam(distance, value)} left="가까이 · 밀도 있게" right="멀리 · 여유 있게"/>
    </div>
  </div>
}

type TunerState = { kind: 'off' } | { kind: 'native' } | { kind: 'waiting' } | { kind: 'silent' } | { kind: 'reading'; reading: TunerReading }
/** Keep the last note on screen briefly so a decaying string does not flicker to "no signal". */
const TUNER_HOLD_MS = 450
const TUNER_INTERVAL_MS = 60

/**
 * Pedal tuner. Engaging it mutes the rig output (DSP side); while engaged the editor polls the rig's
 * analyser tap and shows note + cents. Only the Web Audio engine streams that tap to the UI.
 */
function useTuner(deviceId: string, enabled: boolean): TunerState {
  const native = isDesktopApp()
  const [state, setState] = useState<TunerState>({ kind: 'off' })
  useEffect(() => {
    if (!enabled) { setState({ kind: 'off' }); return }
    if (native) { setState({ kind: 'native' }); return }
    let frame = 0, last = 0, lastHit = -Infinity
    let buffer: Float32Array<ArrayBuffer> | null = null
    let held: TunerReading | null = null
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick)
      if (time - last < TUNER_INTERVAL_MS) return
      last = time
      const tap = guitarTunerTap(deviceId)
      if (!tap) { held = null; setState(current => current.kind === 'waiting' ? current : { kind: 'waiting' }); return }
      if (buffer?.length !== tap.analyser.fftSize) buffer = new Float32Array(tap.analyser.fftSize)
      tap.analyser.getFloatTimeDomainData(buffer)
      const hz = detectPitch(buffer, tap.sampleRate)
      if (hz) {
        const next = tunerReading(hz, TUNER_A4)
        // Light smoothing on the needle while the same note rings.
        held = held && held.midi === next.midi ? { ...next, cents: Math.round((held.cents * 0.5 + next.cents * 0.5) * 10) / 10 } : next
        lastHit = time
        setState({ kind: 'reading', reading: held })
      } else if (time - lastHit > TUNER_HOLD_MS) {
        held = null
        setState(current => current.kind === 'silent' ? current : { kind: 'silent' })
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [deviceId, enabled, native])
  return state
}

/** The tuner pedal in a rack slot: note, cents and needle drawn in the art's display window. */
function TunerPedal({ deviceId, onToggle, enabled }: { deviceId: string; onToggle(): void; enabled: boolean }) {
  const meta = PEDAL_META.tuner
  const state = useTuner(deviceId, enabled)
  const [left, top, width, height] = TUNER_WINDOW
  const reading = state.kind === 'reading' ? state.reading : null
  const inTune = reading ? Math.abs(reading.cents) <= 3 : false
  const message = state.kind === 'off' ? '꺼짐 · 통과' : state.kind === 'native' ? '음소거 · 데스크톱 미지원' : state.kind === 'waiting' ? '엔진 대기 중' : state.kind === 'silent' ? '줄을 튕겨 주세요' : ''
  return <div className="gr-pedal-stage gr-pedal-tuner" data-bypassed={!enabled}>
    <img className="gr-pedal-art" src={meta.image} alt="" width={360} height={600} draggable={false}/><span className="gr-port gr-port-in" aria-hidden="true"/><span className="gr-port gr-port-out" aria-hidden="true"/>
    <div className="gr-tuner-screen" data-state={state.kind} data-in-tune={inTune} role="status" aria-label={reading ? `${reading.note}${reading.octave}, ${reading.cents.toFixed(0)} 센트` : message} style={{ left, top, width, height }}>
      {reading ? <>
        <span className="gr-tuner-note">{reading.note}<sub>{reading.octave}</sub></span>
        <span className="gr-tuner-cents">{reading.cents > 0 ? '+' : ''}{reading.cents.toFixed(0)}¢</span>
        <span className="gr-tuner-scale"><i className="gr-tuner-center"/><i className="gr-tuner-needle" style={{ left: `${50 + Math.max(-50, Math.min(50, reading.cents))}%` }}/></span>
      </> : <span className="gr-tuner-message">{message}</span>}
    </div>
    <span className="gr-pedal-led" data-on={enabled} aria-hidden="true"/><button className="gr-footswitch" aria-label={`${meta.name} 켜기(출력 음소거)/끄기`} aria-pressed={enabled} title={`${meta.name} ${enabled ? '켜짐 · 음소거' : '꺼짐'}`} onClick={onToggle}/>
  </div>
}
