import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  cloneWavetablePatch, combineWavetablePatch, createDefaultWavetablePatch,
  createDefaultWavetableState, getFactoryWavetableFrames, parseWavetablePatch,
  parseWavetablePatchJson, parseWavetableState, sanitizeWavetablePatch,
  serializeWavetablePatch, splitWavetablePatch,
} from './model'
import type { WavetablePatch } from './model'
import {
  encodeWavetablePatch, WAVE_BINARY_HEADER_BYTES, WavetablePreviewSession,
  wavetableBridgeStatus,
} from './bridge'
import type { WavetableBridgeStatus, WavetableNativeBridge } from './bridge'
import { WAVE_LIMITS, WAVE_MODULATION_SOURCES, WAVE_PARAMETER_SCHEMA, WAVE_SCHEMA_FINGERPRINT } from './schema.generated'
import { getWavetablePreset, WAVE_PRESETS } from './presets'

function customPatch(): WavetablePatch {
  const patch = createDefaultWavetablePatch()
  patch.customBanks = [{ slot: 4, name: '나의 웨이브', frames: [Array.from({ length: 2048 }, (_, i) => Math.sin(i / 2048 * Math.PI * 2))] }]
  patch.params.osc1Bank = 4
  patch.params.env1Hold = 0.125
  patch.lfoCurves[1][5] = 0.12345
  patch.routes = [{ id: 'test-route', enabled: true, source: 'lfo2', destination: 'filter1Cutoff', amount: -0.27, bipolar: true, aux: 'macro2', curve: 0.3 }]
  patch.metadata = { name: '나의 음색', author: '테스트', description: '파형과 변조를 함께 저장합니다.' }
  return patch
}

function host() {
  let status: WavetableBridgeStatus = Object.freeze({ available: true, backend: 'offline', sampleRate: 48000 })
  const listeners = new Set<(status: WavetableBridgeStatus) => void>()
  const requests: { revision: number; resolve: (ack: { revision: number }) => void; reject: (error: Error) => void }[] = []
  const bridge: WavetableNativeBridge = {
    protocolVersion: 1,
    getStatus: () => status,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    applyPatch: vi.fn((_trackId, _patch, revision) => new Promise<{ revision: number }>((resolve, reject) => requests.push({ revision, resolve, reject }))),
    previewNoteOn: vi.fn(), previewNoteOff: vi.fn(), allNotesOff: vi.fn(),
  }
  return {
    bridge, requests, listeners,
    emit: (next: WavetableBridgeStatus) => { status = Object.freeze(next); for (const listener of listeners) listener(status) },
    ack: (index: number) => requests[index].resolve({ revision: requests[index].revision }),
  }
}

describe('IEUM WAVE saved patch', () => {
  it('round-trips custom samples, drawn LFOs, matrix routes and metadata without loss', () => {
    const patch = customPatch()
    const json = serializeWavetablePatch(patch)
    expect(parseWavetablePatchJson(json)).toEqual(patch)
    const split = splitWavetablePatch(patch)
    expect('params' in split.state).toBe(false)
    expect(combineWavetablePatch(split.params, JSON.parse(JSON.stringify(split.state)))).toEqual(patch)
  })

  it('keeps defaults, parsed state, split state and composed editor state isolated', () => {
    const original = customPatch()
    const cloned = cloneWavetablePatch(original)
    cloned.params.level = 0
    cloned.customBanks[0].frames[0][10] = -1
    cloned.lfoCurves[1][5] = 1
    cloned.routes[0].amount = 1
    cloned.metadata.name = 'changed'
    expect(original).toEqual(customPatch())
    const split = splitWavetablePatch(original)
    const combined = combineWavetablePatch(split.params, split.state)
    combined.customBanks[0].frames[0][5] = -1
    combined.params.osc1Position = 0
    expect(split.state.customBanks[0].frames[0][5]).toBe(original.customBanks[0].frames[0][5])
    expect(split.params.osc1Position).toBe(original.params.osc1Position)
    const defaults = createDefaultWavetableState()
    defaults.lfoCurves[0][3] = 0.8
    expect(createDefaultWavetableState().lfoCurves[0][3]).not.toBe(0.8)
  })

  it('fills known missing scalars and absent track state with version-one defaults', () => {
    const patch = combineWavetablePatch({ level: 0.2 })
    expect(patch.params.level).toBe(0.2)
    expect(patch.params.osc1Unison).toBe(1)
    expect(patch.params.env1Hold).toBe(0)
    expect(patch.lfoCurves).toHaveLength(4)
    expect(Object.keys(patch.params)).toHaveLength(WAVE_PARAMETER_SCHEMA.length)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite data (%s) at each DSP boundary', value => {
    const scalar = createDefaultWavetablePatch(); scalar.params.level = value
    expect(() => parseWavetablePatch(scalar)).toThrow(/유한한 숫자/)
    expect(() => sanitizeWavetablePatch(scalar)).toThrow(/유한한 숫자/)
    const sample = customPatch(); sample.customBanks[0].frames[0][0] = value
    expect(() => parseWavetablePatch(sample)).toThrow(/frames/)
    const lfo = createDefaultWavetablePatch(); lfo.lfoCurves[2][17] = value
    expect(() => parseWavetablePatch(lfo)).toThrow(/lfoCurves/)
    const route = customPatch(); route.routes[0].amount = value
    expect(() => parseWavetablePatch(route)).toThrow(/amount/)
    const curve = customPatch(); curve.routes[0].curve = value
    expect(() => parseWavetablePatch(curve)).toThrow(/curve/)
  })

  it('rejects future versions, unknown IDs, unsupported modulation and missing user banks', () => {
    expect(() => parseWavetableState({ version: 2 })).toThrow(/버전/)
    expect(() => combineWavetablePatch({ madeUpOsc: 0 })).toThrow(/알 수 없는/)
    expect(() => combineWavetablePatch({ osc1Bank: 4 })).toThrow(/데이터가 없습니다/)
    const patch = customPatch()
    patch.routes[0].destination = 'delayMix'
    expect(() => parseWavetablePatch(patch)).toThrow(/변조 대상/)
    expect(() => parseWavetableState({ version: 1, params: {} })).toThrow(/지원하지 않는 필드/)
    expect(() => parseWavetableState({ version: 1, customBanks: null })).toThrow(/customBanks/)
    expect(() => parseWavetableState({ version: 1, routes: null })).toThrow(/routes/)
  })

  it('rejects duplicate route IDs, bank slots and sparse sample arrays', () => {
    const routes = customPatch(); routes.routes.push({ ...routes.routes[0] })
    expect(() => parseWavetablePatch(routes)).toThrow(/중복된 변조/)
    const banks = customPatch(); banks.customBanks.push({ ...banks.customBanks[0] })
    expect(() => parseWavetablePatch(banks)).toThrow(/중복된 사용자/)
    const sparse = customPatch(); delete sparse.customBanks[0].frames[0][7]
    expect(() => parseWavetablePatch(sparse)).toThrow(/유한한 숫자/)
  })

  it('enforces bank, frame, curve and route caps before consuming their payload', () => {
    expect(() => parseWavetableState({ version: 1, customBanks: Array(5) })).toThrow(/최대 4개/)
    expect(() => parseWavetableState({ version: 1, routes: Array(17) })).toThrow(/최대 16개/)
    const frames = customPatch(); frames.customBanks[0].frames = Array(17)
    expect(() => parseWavetablePatch(frames)).toThrow(/최대 16개/)
    const samples = customPatch(); samples.customBanks[0].frames[0] = Array(2049)
    expect(() => parseWavetablePatch(samples)).toThrow(/정확히 2048개/)
    const curves = createDefaultWavetablePatch(); curves.lfoCurves[0] = Array(129)
    expect(() => parseWavetablePatch(curves)).toThrow(/정확히 128개/)
    expect(() => parseWavetablePatchJson(' '.repeat(WAVE_LIMITS.maxTextBytes + 1))).toThrow(/4 MiB/)
  })

  it('separates strict parsing from explicit finite scalar repair', () => {
    const patch = createDefaultWavetablePatch()
    patch.params.level = 12
    patch.params.osc1Unison = 2.4
    patch.params.pitchBendRange = 2.7
    expect(() => parseWavetablePatch(patch)).toThrow(/params/)
    const sanitized = sanitizeWavetablePatch(patch)
    expect(sanitized.params.level).toBe(1)
    expect(sanitized.params.osc1Unison).toBe(2)
    expect(sanitized.params.pitchBendRange).toBe(3)
    expect(patch.params.level).toBe(12)
    patch.lfoCurves[0][0] = 2
    expect(() => sanitizeWavetablePatch(patch)).toThrow(/lfoCurves/)
  })

  it('ships ten distinct valid original presets and returns editable independent copies', () => {
    expect(WAVE_PRESETS).toHaveLength(10)
    expect(new Set(WAVE_PRESETS.map(preset => preset.id)).size).toBe(10)
    expect(new Set(WAVE_PRESETS.map(preset => JSON.stringify(preset.patch.params))).size).toBe(10)
    for (const preset of WAVE_PRESETS) expect(parseWavetablePatch(preset.patch)).toEqual(preset.patch)
    const editable = getWavetablePreset('warm-loft')
    editable.params.level = 0
    editable.lfoCurves[0][1] = 0.9
    expect(getWavetablePreset('warm-loft').params.level).toBeGreaterThan(0)
    expect(Object.isFrozen(WAVE_PRESETS[0].patch.params)).toBe(true)
    expect(() => getWavetablePreset('not-a-preset')).toThrow(/알 수 없는/)
  })

  it('produces finite DC-free original factory cycles with bank-wide normalization', () => {
    for (let bank = 0; bank < 4; bank++) {
      const frames = getFactoryWavetableFrames(bank)
      expect(frames).toHaveLength(8)
      let peak = 0
      for (const frame of frames) {
        expect(frame).toHaveLength(2048)
        expect(Math.abs(frame.reduce((sum, sample) => sum + sample, 0) / frame.length)).toBeLessThan(1e-12)
        for (const sample of frame) { expect(Number.isFinite(sample)).toBe(true); peak = Math.max(peak, Math.abs(sample)) }
      }
      expect(peak).toBeCloseTo(1, 12)
      frames[0][0] = 0.75
      expect(getFactoryWavetableFrames(bank)[0][0]).not.toBe(0.75)
    }
  })

  it('keeps generated TypeScript and C++ metadata synchronized with the neutral manifest', () => {
    const generator = fileURLToPath(new URL('./generate-schema.mjs', import.meta.url))
    expect(() => execFileSync(process.execPath, [generator, '--check'], { encoding: 'utf8' })).not.toThrow()
  })
})

describe('IEUM WAVE native control wire', () => {
  it('encodes schema identity, scalar order, LFO curves, modulation flags and samples as little endian', () => {
    const patch = customPatch()
    const bytes = encodeWavetablePatch(patch)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('IEWAVE01')
    expect(view.getUint32(8, true)).toBe(1)
    expect(view.getUint32(12, true)).toBe(WAVE_SCHEMA_FINGERPRINT)
    expect(view.getUint32(16, true)).toBe(WAVE_PARAMETER_SCHEMA.length)
    expect(view.getUint32(20, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(1)
    expect(view.getUint32(28, true)).toBe(0)
    const hold = WAVE_PARAMETER_SCHEMA.find(parameter => parameter.id === 'env1Hold')!.index
    expect(view.getFloat32(WAVE_BINARY_HEADER_BYTES + hold * 4, true)).toBe(0.125)
    const curvesOffset = WAVE_BINARY_HEADER_BYTES + WAVE_PARAMETER_SCHEMA.length * 4
    expect(view.getFloat32(curvesOffset + (128 + 5) * 4, true)).toBeCloseTo(0.12345)
    const routesOffset = curvesOffset + 4 * 128 * 4
    expect(view.getUint32(routesOffset, true)).toBe(WAVE_MODULATION_SOURCES.find(source => source.id === 'lfo2')!.index)
    expect(view.getUint32(routesOffset + 4, true)).toBe(WAVE_PARAMETER_SCHEMA.find(parameter => parameter.id === 'filter1Cutoff')!.index)
    expect(view.getUint32(routesOffset + 8, true)).toBe(WAVE_MODULATION_SOURCES.find(source => source.id === 'macro2')!.index)
    expect(view.getUint32(routesOffset + 12, true)).toBe(3)
    expect(view.getFloat32(routesOffset + 16, true)).toBeCloseTo(-0.27)
    expect(view.getFloat32(routesOffset + 20, true)).toBeCloseTo(0.3)
    const bankOffset = routesOffset + 24
    expect(view.getUint32(bankOffset, true)).toBe(4)
    expect(view.getUint32(bankOffset + 4, true)).toBe(1)
    expect(view.getFloat32(bankOffset + 8 + 512 * 4, true)).toBe(1)
    expect(bytes.byteLength).toBe(bankOffset + 8 + 2048 * 4)
  })

  it('bounds the maximum user data payload and rejects invalid state before transport', () => {
    const patch = createDefaultWavetablePatch()
    patch.customBanks = Array.from({ length: 4 }, (_, bank) => ({ slot: bank + 4, name: '', frames: Array.from({ length: 16 }, () => Array(2048).fill(0)) }))
    const bytes = encodeWavetablePatch(patch)
    expect(bytes.length).toBe(32 + WAVE_PARAMETER_SCHEMA.length * 4 + 4 * 128 * 4 + 4 * (8 + 16 * 2048 * 4))
    expect(bytes.length).toBeLessThan(528000)
    patch.params.osc1Unison = 8
    expect(() => encodeWavetablePatch(patch)).toThrow(/범위/)
  })
})

describe('native audition lifecycle', () => {
  it('never enables audition without a connected native host', async () => {
    const session = new WavetablePreviewSession(undefined, 'track')
    expect(wavetableBridgeStatus().available).toBe(false)
    expect(await session.applyPatch(createDefaultWavetablePatch())).toBe(false)
    expect(session.noteOn(60)).toBe(false)
    expect(session.getSnapshot().error).toContain('아직 연결되지')
    session.dispose()
  })

  it('ignores old acknowledgements and enables only the newest applied revision', async () => {
    const mock = host()
    const session = new WavetablePreviewSession(mock.bridge, 'track')
    const first = session.applyPatch(createDefaultWavetablePatch())
    const second = session.applyPatch(getWavetablePreset('low-orbit'))
    expect(session.noteOn(60)).toBe(false)
    mock.ack(0)
    expect(await first).toBe(false)
    expect(session.getSnapshot().pending).toBe(true)
    mock.ack(1)
    expect(await second).toBe(true)
    expect(session.noteOn(48, 0.7)).toBe(true)
    expect(mock.bridge.previewNoteOn).toHaveBeenCalledWith('track', 48, 0.7, 0)
    session.dispose()
  })

  it('keeps held notes alive during edits and forwards their release while a patch is pending', async () => {
    const mock = host()
    const session = new WavetablePreviewSession(mock.bridge, 'track')
    const initial = session.applyPatch(createDefaultWavetablePatch()); mock.ack(0); await initial
    expect(session.noteOn(60)).toBe(true)
    const edited = createDefaultWavetablePatch(); edited.params.filter1Cutoff = 840
    const pending = session.applyPatch(edited)
    expect(mock.bridge.allNotesOff).not.toHaveBeenCalled()
    expect(session.noteOn(62)).toBe(false)
    session.noteOff(60)
    expect(mock.bridge.previewNoteOff).toHaveBeenCalledWith('track', 60, 0)
    mock.ack(1); await pending
    expect(session.noteOn(62)).toBe(true)
    session.dispose()
  })

  it('invalidates pending acknowledgements on disconnect and stops audition notes', async () => {
    const mock = host()
    const session = new WavetablePreviewSession(mock.bridge, 'track')
    const pending = session.applyPatch(createDefaultWavetablePatch())
    mock.emit({ available: false, reason: '오디오 장치 연결 해제' })
    mock.ack(0)
    expect(await pending).toBe(false)
    expect(session.getSnapshot()).toMatchObject({ ready: false, pending: false, error: '오디오 장치 연결 해제' })
    expect(mock.bridge.allNotesOff).toHaveBeenCalledWith('track')
    session.dispose()
    expect(mock.listeners.size).toBe(0)
  })

  it('surfaces patch failures and mismatched acknowledgements without enabling notes', async () => {
    const mock = host()
    const session = new WavetablePreviewSession(mock.bridge, 'track')
    const failed = session.applyPatch(createDefaultWavetablePatch())
    mock.requests[0].reject(new Error('테이블 준비 실패'))
    expect(await failed).toBe(false)
    expect(session.getSnapshot().error).toBe('테이블 준비 실패')
    const mismatch = session.applyPatch(createDefaultWavetablePatch())
    mock.requests[1].resolve({ revision: 99 })
    expect(await mismatch).toBe(false)
    expect(session.getSnapshot().error).toContain('번호가 일치')
    expect(session.noteOn(60)).toBe(false)
    session.dispose()
  })

  it('releases notes once on disposal, ignores late replies and uses newer revisions when reopened', async () => {
    const mock = host()
    const first = new WavetablePreviewSession(mock.bridge, 'track')
    expect(mock.listeners.size).toBe(0)
    const pending = first.applyPatch(createDefaultWavetablePatch())
    first.dispose(); first.dispose()
    expect(mock.bridge.allNotesOff).toHaveBeenCalledTimes(1)
    const second = new WavetablePreviewSession(mock.bridge, 'track')
    const reopened = second.applyPatch(createDefaultWavetablePatch())
    expect(mock.requests[1].revision).toBeGreaterThan(mock.requests[0].revision)
    mock.ack(0); expect(await pending).toBe(false)
    mock.ack(1); expect(await reopened).toBe(true)
    expect(first.noteOn(60)).toBe(false)
    second.dispose()
  })
})
