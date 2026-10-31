import { afterEach, describe, expect, it, vi } from 'vitest'
import { SampleLibrary, chooseFormat, parseManifest, pickZone, type SampleSet, type SampleZone } from './samples'

const zone = (file: string, root: number, lo: number, hi: number, vlo = 0, vhi = 1, extra: Partial<SampleZone> = {}): SampleZone =>
  ({ file, root, lo, hi, vlo, vhi, ...extra })

const piano: Pick<SampleSet, 'kind' | 'zones'> = {
  kind: 'pitched',
  zones: [
    zone('C4v1', 60, 58, 62, 0, 0.34), zone('C4v2', 60, 58, 62, 0.34, 0.67), zone('C4v3', 60, 58, 62, 0.67, 1),
    zone('F4v1', 65, 63, 67, 0, 0.5), zone('F4v2', 65, 63, 67, 0.5, 1),
  ],
}

describe('pickZone', () => {
  it('matches the key range and the half-open velocity layer', () => {
    expect(pickZone(piano, 61, 0.1)?.file).toBe('C4v1')
    expect(pickZone(piano, 61, 0.34)?.file).toBe('C4v2')
    expect(pickZone(piano, 62, 0.66)?.file).toBe('C4v2')
    expect(pickZone(piano, 63, 0.5)?.file).toBe('F4v2')
  })

  it('lets the loudest layer take velocity 1 and falls back to the nearest layer', () => {
    expect(pickZone(piano, 60, 1)?.file).toBe('C4v3')
    expect(pickZone(piano, 65, 1)?.file).toBe('F4v2')
    const sparse = { kind: 'pitched' as const, zones: [zone('A', 69, 60, 72, 0.3, 0.6), zone('B', 69, 60, 72, 0.6, 0.9)] }
    expect(pickZone(sparse, 69, 0.1)?.file).toBe('A')
    expect(pickZone(sparse, 69, 0.99)?.file).toBe('B')
  })

  it('returns nothing outside every key range and prefers the nearest root when ranges overlap', () => {
    expect(pickZone(piano, 40, 0.5)).toBeUndefined()
    const overlapping = { kind: 'pitched' as const, zones: [zone('low', 60, 55, 70), zone('high', 67, 55, 70)] }
    expect(pickZone(overlapping, 62, 0.5)?.file).toBe('low')
    expect(pickZone(overlapping, 66, 0.5)?.file).toBe('high')
  })

  it('maps kits by exact root only, ignoring lo/hi', () => {
    const kit = { kind: 'kit' as const, zones: [zone('kick', 36, 36, 36), zone('snare-soft', 38, 38, 38, 0, 0.6), zone('snare-hard', 38, 38, 38, 0.6, 1)] }
    expect(pickZone(kit, 36, 0.9)?.file).toBe('kick')
    expect(pickZone(kit, 37, 0.9)).toBeUndefined()
    expect(pickZone(kit, 38, 0.2)?.file).toBe('snare-soft')
    expect(pickZone(kit, 38, 0.6)?.file).toBe('snare-hard')
  })

  it('picks release zones from the alternate list', () => {
    const releases = [zone('rel-lo', 48, 0, 63), zone('rel-hi', 72, 64, 127)]
    expect(pickZone(piano, 60, 0.5, releases)?.file).toBe('rel-lo')
    expect(pickZone(piano, 80, 0.5, releases)?.file).toBe('rel-hi')
  })
})

describe('parseManifest', () => {
  it('fills defaults, forces kit zones onto their root, and rejects empty sets', () => {
    const set = parseManifest({
      kind: 'kit', formats: ['webm', 'm4a', 'flac'], zones: [
        { file: 'kick', root: 36, lo: 0, hi: 127, choke: 1, loop: [0.5, 0.2] },
        { file: '../evil', root: 38 },
        { file: 'hat', root: 42, gainDb: -3, tune: 10, loop: [0.1, 0.4] },
      ],
    }, 'kit')
    expect(set.formats).toEqual(['webm', 'm4a'])
    expect(set.gainDb).toBe(0)
    expect(set.release).toBe(0.25)
    expect(set.zones.map(z => z.file)).toEqual(['kick', 'hat'])
    expect(set.zones[0]).toMatchObject({ lo: 36, hi: 36, vlo: 0, vhi: 1, choke: 1 })
    expect(set.zones[0].loop).toBeUndefined()
    expect(set.zones[1]).toMatchObject({ gainDb: -3, tune: 10, loop: [0.1, 0.4] })
    expect(set.attribution.title).toBe('kit')
    expect(() => parseManifest({ formats: ['webm'], zones: [] }, 'x')).toThrow(/no zones/)
    expect(() => parseManifest({ formats: ['flac'], zones: [{ file: 'a', root: 60 }] }, 'x')).toThrow(/formats/)
  })

  it('prefers webm when the probe cannot run', () => {
    expect(chooseFormat(['m4a', 'webm'])).toBe('webm')
    expect(chooseFormat(['m4a'])).toBe('m4a')
  })
})

describe('SampleLibrary', () => {
  const manifest = {
    id: 't', kind: 'pitched', formats: ['webm', 'm4a'], gainDb: -6, release: 0.3,
    zones: [{ file: 'A4', root: 69, lo: 0, hi: 127, vlo: 0, vhi: 1 }, { file: 'B4', root: 71, lo: 0, hi: 127, vlo: 0, vhi: 1 }],
    releaseZones: [{ file: 'A4', root: 69, lo: 0, hi: 127 }],
    attribution: { title: 'Fixture', author: 'ffmpeg', license: 'CC0' },
  }
  const requests: string[] = []
  let inFlight = 0
  let peak = 0
  const context = {
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({ duration: bytes.byteLength } as unknown as AudioBuffer)),
  } as unknown as BaseAudioContext

  function installFetch(fail?: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1
      if (fail && url.includes(fail)) return new Response(null, { status: 404 })
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest))
      return new Response(new Uint8Array(url.length))
    }))
  }

  afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; peak = 0 })

  it('fetches the manifest and every unique file once, shares the in-flight load, and reports status', async () => {
    installFetch()
    const library = new SampleLibrary('/app/')
    const events: string[] = []
    library.subscribe((id, status) => events.push(`${id}:${status}`))
    expect(library.status('t')).toBe('idle')
    const first = library.load('t', context)
    const second = library.load('t', context)
    expect(first).toBe(second)
    expect(library.status('t')).toBe('loading')
    const loaded = await first
    expect(library.status('t')).toBe('ready')
    expect(library.get('t')).toBe(loaded)
    expect(loaded.format).toBe('webm')
    expect(loaded.startOffset).toBe(0)
    expect(loaded.set.attribution.title).toBe('Fixture')
    expect([...loaded.buffers.keys()].sort()).toEqual(['A4', 'B4'])
    expect(requests).toEqual(['/app/samples/t/manifest.json', '/app/samples/t/A4.webm', '/app/samples/t/B4.webm'])
    expect(peak).toBeLessThanOrEqual(6)
    expect(events).toEqual(['t:loading', 't:ready'])
    await library.load('t', context)
    expect(requests).toHaveLength(3)
  })

  it('records an error for a missing file and allows a retry', async () => {
    installFetch('B4')
    const library = new SampleLibrary('/')
    await expect(library.load('t', context)).rejects.toThrow(/B4\.webm/)
    expect(library.status('t')).toBe('error')
    expect(library.error('t')).toMatch(/B4/)
    expect(library.get('t')).toBeUndefined()
    installFetch()
    await library.load('t', context)
    expect(library.status('t')).toBe('ready')
  })

  it('rejects set ids that could escape the samples folder', async () => {
    installFetch()
    const library = new SampleLibrary('/')
    await expect(library.load('../x', context)).rejects.toThrow(/Invalid/)
    expect(requests).toEqual([])
  })
})
