import { describe, expect, it } from 'vitest'
import { readPcmTransfer } from '../../../desktop/pcmTransfer'
import { packAudioBuffer, packPcm, unpackPcm } from './pcmTransfer'
import { SampleLibrary } from '../samples'

const MAX = 512 * 1024 * 1024
const ramp = (frames: number, scale: number) => Float32Array.from({ length: frames }, (_, i) => Math.sin(i * scale) * 0.9)

describe('binary PCM transfer (renderer pack -> IPC clone -> main read)', () => {
  it.each([1, 2, 3, 6])('round-trips %i channel(s) bit-exactly through structured clone', channels => {
    const planar = Array.from({ length: channels }, (_, c) => ramp(1027, 0.01 * (c + 1)))
    const packed = packPcm(44100, planar)
    expect(packed).toMatchObject({ encoding: 'f32le-interleaved', sampleRate: 44100, channels, frames: 1027 })
    expect(packed.data.byteLength).toBe(1027 * channels * 4)
    // Electron's IPC uses structured clone: the attachment arrives as one Uint8Array.
    const received = readPcmTransfer(structuredClone({ id: 'x', ...packed }), MAX)
    expect(received).toMatchObject({ sampleRate: 44100, channels, frames: 1027 })
    // The bytes the main process writes are the host's interleaved little-endian .f32 layout.
    const view = new DataView(received.data.buffer, received.data.byteOffset, received.data.byteLength)
    for (const frame of [0, 1, 513, 1026]) for (let c = 0; c < channels; c++) expect(view.getFloat32((frame * channels + c) * 4, true)).toBe(planar[c][frame])
    expect(unpackPcm({ ...packed, data: received.data })).toEqual(planar)
  })

  it('copies mono, so the caller may release the source buffer', () => {
    const source = ramp(16, 0.3)
    const packed = packPcm(48000, [source])
    source.fill(0)
    expect(unpackPcm(packed)[0][3]).not.toBe(0)
  })

  it('packs an AudioBuffer and still accepts the legacy planar form', () => {
    const left = ramp(64, 0.1), right = ramp(64, 0.2)
    const buffer = { sampleRate: 48000, numberOfChannels: 2, length: 64, getChannelData: (c: number) => c ? right : left } as unknown as AudioBuffer
    const packed = packAudioBuffer(buffer)
    const legacy = readPcmTransfer({ sampleRate: 48000, channels: [left, right] }, MAX)
    expect(legacy.data).toEqual(packed.data)
  })

  it('rejects non-finite samples, size mismatches, and bad metadata', () => {
    const bad = packPcm(48000, [Float32Array.of(0, Number.NaN)])
    expect(() => readPcmTransfer({ ...bad }, MAX)).toThrow(/유효하지 않은 샘플/)
    expect(() => readPcmTransfer({ ...packPcm(48000, [Float32Array.of(0, Infinity)]) }, MAX)).toThrow(/유효하지 않은 샘플/)
    const good = packPcm(48000, [Float32Array.of(0, 0.5)])
    expect(() => readPcmTransfer({ ...good, frames: 3 }, MAX)).toThrow(/size/)
    expect(() => readPcmTransfer({ ...good, sampleRate: 100 }, MAX)).toThrow(/sample rate/)
    expect(() => readPcmTransfer({ ...good, channels: 0 }, MAX)).toThrow(/channels/)
    expect(() => readPcmTransfer({ ...good, data: [0, 0] }, MAX)).toThrow(/size/)
    expect(() => readPcmTransfer({ ...good }, 4)).toThrow(/size/)
    // A misaligned view (possible from a Buffer pool) is copied before the float check.
    const shifted = new Uint8Array(good.data.byteLength + 1); shifted.set(good.data, 1)
    expect(readPcmTransfer({ ...good, data: shifted.subarray(1) }, MAX).data).toEqual(good.data)
  })

  it('60 s stereo: packing + clone + main read stays near a plain copy (no per-sample writeFloatLE)', () => {
    const frames = 48000 * 60, planar = [ramp(frames, 0.001), ramp(frames, 0.002)]
    const time = (fn: () => void) => { fn(); const t0 = performance.now(); fn(); return performance.now() - t0 }
    const copy = time(() => { const out = new Float32Array(frames * 2); out.set(planar[0]); out.set(planar[1], frames) })
    const legacy = time(() => {
      const data = Buffer.allocUnsafe(frames * 8)
      for (let f = 0; f < frames; f++) for (let c = 0; c < 2; c++) data.writeFloatLE(planar[c][f], (f * 2 + c) * 4)
    })
    const binary = time(() => { readPcmTransfer(packPcm(48000, planar) as unknown as Record<string, unknown>, MAX) })
    console.info(`PCM 60 s stereo: plain copy ${copy.toFixed(1)} ms, legacy writeFloatLE ${legacy.toFixed(1)} ms, binary pack+read ${binary.toFixed(1)} ms`)
    expect(binary).toBeLessThan(legacy)
  })
})

describe('sample library release (desktop host owns the PCM)', () => {
  it('drops decoded buffers, keeps the manifest, and decodes again on the next load', async () => {
    const library = new SampleLibrary('/')
    const set = { id: 'set', kind: 'pitched', formats: ['webm'], gainDb: 0, release: 0.1, zones: [{ file: 'a', root: 60, lo: 0, hi: 127, vlo: 0, vhi: 1 }], releaseZones: [], attribution: { title: 't', author: 'a', license: 'CC0' } }
    let fetches = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      fetches += 1
      return url.endsWith('manifest.json') ? new Response(JSON.stringify(set)) : new Response(new Uint8Array(8))
    }) as typeof fetch
    try {
      const context = { decodeAudioData: async () => ({ duration: 1 }) as AudioBuffer } as unknown as BaseAudioContext
      const loaded = await library.load('set', context)
      expect(loaded.buffers.size).toBe(1)
      library.release('set')
      expect(library.get('set')).toBeUndefined()
      expect(library.status('set')).toBe('idle')
      expect(library.manifest('set')?.attribution.title).toBe('t')
      const before = fetches
      expect((await library.load('set', context)).buffers.size).toBe(1)
      expect(fetches).toBeGreaterThan(before)
    } finally { globalThis.fetch = realFetch }
  })
})
