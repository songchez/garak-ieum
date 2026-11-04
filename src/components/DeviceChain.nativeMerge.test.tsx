import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDevice, createTrack } from '../core/project'
import type { AudioEngine, Track } from '../core/types'
import type { WavetableNativeBridge } from '../devices/wavetable-synth/bridge'
import { DeviceChain } from './DeviceChain'

const noop = () => {}
const nativeEngine = (wavetable?: WavetableNativeBridge) => ({
  kind: 'native', wavetable,
  subscribeSamples: () => noop,
  sampleStatus: () => 'idle',
  sampleAttribution: () => null,
}) as unknown as AudioEngine

function render(track: Track, engine = nativeEngine()) {
  return renderToStaticMarkup(<DeviceChain track={track} engine={engine}
    onInstrumentChange={noop} onInstrumentParam={noop} onWavetablePatch={noop}
    onDeviceParam={noop} onDeviceParams={noop} onAddDevice={noop} onRemoveDevice={noop}
    onMoveDevice={noop} onToggleDevice={noop} onTrackChange={noop} onPreview={noop}/>)
}

function previewButton(markup: string): string {
  const button = markup.match(/<button class="dc-preview"[^>]*>/)?.[0]
  expect(button, 'the selected source must expose its own preview control').toBeDefined()
  return button!
}

describe('native and wavetable source cards', () => {
  it('keeps wave editing and the guitar chain available without claiming a native wavetable capability', () => {
    const track = createTrack('instrument', 'wavetable')
    track.devices = [createDevice('guitar-rig')]
    const markup = render(track)
    expect(markup).toContain('aria-label="IEUM WAVE 편집기 열기"')
    expect(markup).toContain('음색 편집 · 저장 가능 / 엔진 연결 대기')
    expect(markup).toContain('dc-guitar-summary')
    expect(previewButton(markup)).toContain('disabled=""')
  })

  it('enables wave preview only for an explicitly available wavetable bridge', () => {
    const status = Object.freeze({ available: true })
    const bridge: WavetableNativeBridge = {
      protocolVersion: 1, getStatus: () => status, subscribe: () => noop,
      applyPatch: async (_trackId, _patch, revision) => ({ revision }),
      previewNoteOn: noop, previewNoteOff: noop, allNotesOff: noop,
    }
    const markup = render(createTrack('instrument', 'wavetable'), nativeEngine(bridge))
    expect(previewButton(markup)).not.toContain('disabled=')
    expect(markup).toContain('네이티브 음원 연결됨')
  })

  it('shows the VST3 source and its bypass state instead of a retained underlying wave patch', () => {
    const track = createTrack('instrument', 'wavetable')
    track.pluginInstrument = {
      id: 'instance', pluginId: 'approved-plugin', classId: '0123456789ABCDEF0123456789ABCDEF',
      name: 'Merge test synth', enabled: true, parameters: {},
    }
    let markup = render(track)
    expect(markup).toContain('aria-label="VST3 악기 Merge test synth"')
    expect(markup).toContain('VST3 설정 열기')
    expect(markup).not.toContain('aria-label="IEUM WAVE 편집기 열기"')
    expect(previewButton(markup)).not.toContain('disabled=')
    markup = render({ ...track, pluginInstrument: { ...track.pluginInstrument, enabled: false } })
    expect(previewButton(markup)).toContain('disabled=""')
    expect(markup).not.toContain('aria-label="IEUM WAVE 편집기 열기"')
  })
})
