import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HANBAM_106_ID, OKGU_EP_ID, VINTAGE_PARAMS, type VintageInstrumentId } from '../params'
import { presetParams, VINTAGE_PRESETS } from '../presets'
import type { VintageUserPreset } from '../userPresets'
import { pickupTransfer } from './curves'
import { applyPresetChoice, currentPreset, CUSTOM_PRESET_NAME } from './presetActions'
import { VintageEditorPanel } from './VintageEditor'
import { DeviceChain } from '../../../components/DeviceChain'
import { createTrack } from '../../../core/project'
import type { AudioEngine } from '../../../core/types'

const noop = () => {}
function render(instrument: VintageInstrumentId, params: Record<string, number> = {}, extra: { unavailableReason?: string; userPresets?: VintageUserPreset[] } = {}) {
  return renderToStaticMarkup(<VintageEditorPanel instrument={instrument} params={params} onParam={noop} onParams={noop} onClose={noop}
    titleId="t" announce="" onAnnounce={noop} userPresets={extra.userPresets ?? []} unavailableReason={extra.unavailableReason}/>)
}
const user = (id: string, name: string, params: Record<string, number>): VintageUserPreset => ({ id, name, params, savedAt: 0 })

describe('vintage preset application', () => {
  it('applies a factory preset as one call with the complete parameter set and an undo label', () => {
    const onParams = vi.fn()
    const preset = VINTAGE_PRESETS[OKGU_EP_ID][0]
    expect(applyPresetChoice(OKGU_EP_ID, preset.id, [], onParams)).toBe(preset.name)
    expect(onParams).toHaveBeenCalledTimes(1)
    const [params, label] = onParams.mock.calls[0]
    expect(Object.keys(params).sort()).toEqual(VINTAGE_PARAMS[OKGU_EP_ID].map(def => def.id).sort())
    expect(params).toEqual(presetParams(OKGU_EP_ID, preset))
    expect(label).toBe(`옥구슬 EP 프리셋: ${preset.name}`)
  })

  it('applies a user preset sanitised and complete; unknown choices do nothing', () => {
    const onParams = vi.fn()
    const mine = user('u1', '내 패드', { cutoff: 999999, chorus: 3 })
    expect(applyPresetChoice(HANBAM_106_ID, 'user:u1', [mine], onParams)).toBe('내 패드')
    expect(onParams).toHaveBeenCalledTimes(1)
    const [params, label] = onParams.mock.calls[0]
    expect(Object.keys(params)).toHaveLength(VINTAGE_PARAMS[HANBAM_106_ID].length)
    expect(params.cutoff).toBe(18000)
    expect(params.chorus).toBe(3)
    expect(label).toBe('한밤 106 프리셋: 내 패드')
    expect(applyPresetChoice(HANBAM_106_ID, 'user:missing', [mine], onParams)).toBeNull()
    expect(applyPresetChoice(HANBAM_106_ID, 'nope', [mine], onParams)).toBeNull()
    expect(onParams).toHaveBeenCalledTimes(1)
  })

  it('names the current sound: factory, then user, else 사용자 설정', () => {
    const pad = VINTAGE_PRESETS[HANBAM_106_ID][0]
    expect(currentPreset(HANBAM_106_ID, presetParams(HANBAM_106_ID, pad), []).name).toBe(pad.name)
    const edited = { ...presetParams(HANBAM_106_ID, pad), cutoff: 1234 }
    expect(currentPreset(HANBAM_106_ID, edited, []).name).toBe(CUSTOM_PRESET_NAME)
    expect(currentPreset(HANBAM_106_ID, edited, [user('a', '밤', edited)])).toMatchObject({ name: '밤', value: 'user:a' })
  })
})

describe('vintage editor panel', () => {
  it('renders every options parameter of 한밤 106 as a radio group, and knobs for the rest', () => {
    const markup = render(HANBAM_106_ID)
    const groups = [...markup.matchAll(/role="radiogroup" aria-label="([^"]+)"/g)].map(match => match[1])
    const optionDefs = VINTAGE_PARAMS[HANBAM_106_ID].filter(def => def.options)
    expect(groups.sort()).toEqual(optionDefs.map(def => def.label).sort())
    for (const def of optionDefs) expect(markup).not.toMatch(new RegExp(`role="slider"[^>]*aria-label="${def.label}"`))
    // One checked radio per group; the 8' default is selected.
    expect(markup.match(/role="radio" aria-checked="true"/g)).toHaveLength(optionDefs.length)
    expect(markup).toMatch(/aria-checked="true"[^>]*><span>8&#x27;<\/span>/)
    for (const def of VINTAGE_PARAMS[HANBAM_106_ID].filter(item => !item.options)) expect(markup).toContain(`aria-label="${def.label}"`)
  })

  it('shows the header, every 옥구슬 EP control, the pickup curve and the matching preset name', () => {
    const preset = VINTAGE_PRESETS[OKGU_EP_ID][2]
    const markup = render(OKGU_EP_ID, presetParams(OKGU_EP_ID, preset))
    expect(markup).toContain('옥구슬 EP</h2>')
    expect(markup).toContain(`aria-label="옥구슬 EP 프리셋: ${preset.name}"`)
    for (const def of VINTAGE_PARAMS[OKGU_EP_ID]) expect(markup).toContain(`role="slider" tabindex="0" aria-label="${def.label}"`)
    expect(markup).toContain('픽업 전달 곡선')
    expect(markup).not.toContain('role="radiogroup"')
    expect(render(OKGU_EP_ID, { tone: 0.77 })).toContain(`aria-label="옥구슬 EP 프리셋: ${CUSTOM_PRESET_NAME}"`)
  })

  it('shows the unavailable reason as a non-blocking status line', () => {
    expect(render(OKGU_EP_ID)).not.toContain('class="vt-status"')
    const markup = render(OKGU_EP_ID, {}, { unavailableReason: 'WASM을 불러오지 못했습니다' })
    expect(markup).toContain('class="vt-status" role="status"')
    expect(markup).toContain('WASM을 불러오지 못했습니다')
    expect(markup).toContain('role="slider"')
  })

  it('draws the pickup curve with unity slope at zero and asymmetric saturation', () => {
    expect((pickupTransfer(1e-4, 0.8, 0.5, 1) - pickupTransfer(-1e-4, 0.8, 0.5, 1)) / 2e-4).toBeCloseTo(1, 3)
    expect(pickupTransfer(0, 0.8, 0.5, 1)).toBeCloseTo(0, 9)
    expect(Math.abs(pickupTransfer(-1, 0.8, 0.5, 1))).not.toBeCloseTo(Math.abs(pickupTransfer(1, 0.8, 0.5, 1)), 2)
  })
})

describe('vintage source card in the device chain', () => {
  const engine = (available: boolean) => ({
    kind: 'web-audio',
    vintage: { available: () => available, reason: () => available ? '' : 'Rust 코어 없음', subscribe: () => noop },
    subscribeSamples: () => noop, sampleStatus: () => 'idle', sampleAttribution: () => null,
  }) as unknown as AudioEngine
  const card = (instrument: VintageInstrumentId, available: boolean) => renderToStaticMarkup(<DeviceChain track={createTrack('instrument', instrument)} engine={engine(available)}
    onInstrumentChange={noop} onInstrumentParam={noop} onWavetablePatch={noop} onDeviceParam={noop} onDeviceParams={noop} onAddDevice={noop}
    onRemoveDevice={noop} onMoveDevice={noop} onToggleDevice={noop} onTrackChange={noop} onPreview={noop}/>)

  it('shows the compact knob subset and an entry button; the preview explains why it cannot play', () => {
    const markup = card(OKGU_EP_ID, false)
    expect(markup).toContain('aria-label="옥구슬 EP 편집기 열기"')
    expect(markup).toContain('옥구슬 EP 열기')
    const knobs = [...markup.matchAll(/role="slider" tabindex="0" aria-label="([^"]+)"/g)].map(match => match[1])
    expect(knobs).toEqual(expect.arrayContaining(['톤', '바크', '벨', '트레몰로', '앰프 드라이브', '레벨']))
    expect(knobs).not.toContain('픽업 비대칭')
    expect(markup).toMatch(/class="dc-preview"[^>]*disabled=""[^>]*title="Rust 코어 없음"/)
  })

  it('enables preview when the Rust core is available', () => {
    const markup = card(HANBAM_106_ID, true)
    expect(markup).toContain('한밤 106 열기')
    expect(markup).toContain('Rust 음원 연결됨')
    expect(markup).toMatch(/class="dc-preview"[^>]*title="현재 설정으로 미리 듣기"/)
    expect(markup).not.toMatch(/class="dc-preview"[^>]*disabled=""/)
  })
})
