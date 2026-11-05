import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const { spawn } = await import('node:child_process')
const { NativeAudioService } = await import('./native-audio')

type Request = { id: number; method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

/** A stand-in host process: JSON lines in, JSON lines out, as the native protocol. */
function fakeHost(handlers: Record<string, Handler>) {
  const requests: Request[] = []
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: () => { child.killed = true; child.emit('exit', null, 'SIGTERM') } })
  let buffered = ''
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      buffered += chunk.toString()
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const request = JSON.parse(buffered.slice(0, newline)) as Request; buffered = buffered.slice(newline + 1)
        requests.push(request)
        void (async () => {
          try {
            const handler = handlers[request.method] ?? (request.method === 'hello' ? () => ({ protocol: 1 }) : () => ({}))
            child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: await handler(request.params) }) + '\n')
          } catch (error) { child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { message: (error as Error).message } }) + '\n') }
        })()
      }
      done()
    },
    final(done) { done(); setImmediate(() => child.emit('exit', 0, null)) },
  })
  Object.assign(child, { stdin })
  return { child, requests, calls: (method: string) => requests.filter(request => request.method === method).map(request => request.params) }
}

const wav = (frames: number) => { const data = Buffer.alloc(44 + frames * 4); data.write('RIFF', 0, 'ascii'); return data }
const take = (item: Record<string, unknown>) => ({ trackId: item.trackId, takeId: item.takeId, path: item.path, channels: 1, startFrame: 10, rawStartFrame: 10, compensationFrames: 0, compensationKnown: false })

let directory = ''
let services: InstanceType<typeof NativeAudioService>[] = []
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'garak-native-audio-test-')) })
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  await rm(directory, { recursive: true, force: true })
  vi.mocked(spawn).mockReset()
})

async function service(handlers: Record<string, Handler>, allowInput = vi.fn(async () => true)) {
  const executable = join(directory, 'garak-audio-host.exe')
  await writeFile(executable, '')
  const host = fakeHost(handlers)
  vi.mocked(spawn).mockReturnValue(host.child as never)
  const value = new NativeAudioService({ executable, profileDirectory: directory, onState: () => undefined, selectPlugin: async () => null, allowInput })
  services.push(value)
  return { service: value, host, allowInput }
}

describe('native take files', () => {
  it('creates one recovery file per take, never takes a renderer path, and returns every take on stop', async () => {
    const recorded = new Map<string, number>()
    const { service: audio, host } = await service({
      'record.start': params => ({ sampleRate: 48000, takes: (params.takes as Record<string, unknown>[]).map(take) }),
      'record.stop': async () => {
        const takes = host.calls('record.start')[0].takes as Record<string, unknown>[]
        for (const [index, item] of takes.entries()) { recorded.set(String(item.trackId), 10 + index); await writeFile(String(item.path), wav(10 + index)) }
        return { sampleRate: 48000, takes: takes.map(item => ({ ...take(item), frames: recorded.get(String(item.trackId)), sampleRate: 48000 })) }
      },
    })
    const started = await audio.request('record.start', { takes: [{ trackId: 'drums', path: '/untrusted' }, { trackId: 'bass' }] }) as { takes: Record<string, unknown>[] }
    const sent = host.calls('record.start')[0].takes as Record<string, unknown>[]
    expect(sent.map(item => item.trackId)).toEqual(['drums', 'bass'])
    expect(new Set(sent.map(item => item.path)).size).toBe(2)
    for (const item of sent) { expect(String(item.path)).toContain(join(directory, 'native-audio', 'recovery')); expect(String(item.path)).toContain(String(item.takeId)) }
    expect(started.takes.map(item => [item.trackId, item.takeId, 'path' in item])).toEqual([['drums', sent[0].takeId, false], ['bass', sent[1].takeId, false]])
    await expect(audio.request('record.start', { takes: [{ trackId: 'keys' }] })).rejects.toThrow(/이미 녹음/)

    const stopped = await audio.request('record.stop') as { takes: (Record<string, unknown> & { data: Uint8Array })[] }
    expect(stopped.takes.map(item => [item.trackId, item.takeId, item.data.byteLength, 'path' in item])).toEqual([
      ['drums', sent[0].takeId, 44 + 40, false], ['bass', sent[1].takeId, 44 + 44, false],
    ])
    // Files survive until the project commits each take.
    await audio.request('record.commit', { takeId: sent[0].takeId })
    await expect(stat(String(sent[0].path))).rejects.toThrow()
    expect((await readFile(String(sent[1].path))).byteLength).toBe(88)
  })

  it('rejects duplicate, empty and oversized take lists before asking for input or contacting the host', async () => {
    const { service: audio, host, allowInput } = await service({})
    await expect(audio.request('record.start', { takes: [{ trackId: 'a' }, { trackId: 'a' }] })).rejects.toThrow(/하나만/)
    await expect(audio.request('record.start', { takes: [] })).rejects.toThrow(/takes/)
    await expect(audio.request('record.start', { takes: Array.from({ length: 65 }, (_, index) => ({ trackId: `t${index}` })) })).rejects.toThrow(/takes/)
    expect(allowInput).not.toHaveBeenCalled()
    expect(host.calls('record.start')).toHaveLength(0)
  })

  it('removes the created files when the host refuses the takes', async () => {
    const { service: audio, host } = await service({
      'record.start': async params => {
        for (const item of params.takes as Record<string, unknown>[]) await writeFile(String(item.path), wav(0))
        throw new Error('input is not open')
      },
    })
    await expect(audio.request('record.start', { takes: [{ trackId: 'a' }, { trackId: 'b' }] })).rejects.toThrow(/not open/)
    for (const item of host.calls('record.start')[0].takes as Record<string, unknown>[]) await expect(stat(String(item.path))).rejects.toThrow()
    await expect(audio.request('record.stop')).rejects.toThrow(/녹음이 없습니다/)
  })

  it('keeps the former single-take request and reply shape', async () => {
    const { service: audio, host } = await service({
      'record.start': params => ({ sampleRate: 48000, startFrame: 10, rawStartFrame: 10, compensationFrames: 0, compensationKnown: false, channels: 1, takes: [take(params)] }),
      'record.stop': async () => {
        const params = host.calls('record.start')[0]
        await writeFile(String(params.path), wav(4))
        return { path: params.path, startFrame: 10, frames: 4, sampleRate: 48000, channels: 1, takes: [{ ...take(params), frames: 4 }] }
      },
    })
    const started = await audio.request('record.start', { trackId: 'vocal' }) as Record<string, unknown>
    const sent = host.calls('record.start')[0]
    expect(sent).toMatchObject({ trackId: 'vocal', takeId: started.takeId })
    expect(started).toEqual({ sampleRate: 48000, startFrame: 10, rawStartFrame: 10, compensationFrames: 0, compensationKnown: false, channels: 1, takeId: sent.takeId })
    const stopped = await audio.request('record.stop') as Record<string, unknown>
    expect(stopped).toMatchObject({ startFrame: 10, frames: 4, takeId: sent.takeId, name: `Recording-${sent.takeId}.wav` })
    expect('path' in stopped || 'takes' in stopped).toBe(false)
    expect((stopped.data as Uint8Array).byteLength).toBe(60)
  })

  it('forwards the device and latency methods, asking for input permission before a measurement', async () => {
    const allowInput = vi.fn(async () => false)
    const { service: audio, host } = await service({ 'latency.measure': () => ({ roundTripFrames: 128, confidence: 1, attempts: 5 }), 'devices.probe': () => ({ id: 'x' }) }, allowInput)
    await expect(audio.request('latency.measure', { inputChannel: 0 })).rejects.toThrow(/허용되지/)
    expect(host.calls('latency.measure')).toHaveLength(0)
    allowInput.mockResolvedValue(true)
    await expect(audio.request('latency.measure', { inputChannel: 0 })).resolves.toMatchObject({ roundTripFrames: 128 })
    for (const method of ['devices.probe', 'device.suspend', 'device.resume', 'device.clockSource', 'device.directMonitor']) await audio.request(method, {})
    expect(host.requests.map(request => request.method)).toEqual(expect.arrayContaining(['devices.probe', 'device.suspend', 'device.resume', 'device.clockSource', 'device.directMonitor']))
  })
})
