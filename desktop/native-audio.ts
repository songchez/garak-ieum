import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'

type Json = Record<string, unknown>
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface NativeAudioEvent { type: 'state' | 'error'; error?: string | null; [key: string]: unknown }
export interface NativeAudioOptions {
  executable: string
  profileDirectory: string
  onState(event: NativeAudioEvent): void
  selectPlugin(): Promise<string | null>
  allowInput(): Promise<boolean>
  /** Explicit test harness only. Never inferred from failure to open hardware. */
  testClock?: boolean
}
interface CatalogEntry { pluginId: string; classId: string; path: string; name: string; vendor: string; version?: string; isInstrument: boolean; category?: string }
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_PCM_BYTES = 512 * 1024 * 1024
const MAX_TAKES = 64
/** Several takes reach the renderer in one reply; larger ones stay in the recovery folder. */
const MAX_TAKES_BYTES = 2 * 1024 * 1024 * 1024
const METHODS = new Set(['devices.list', 'devices.probe', 'device.suspend', 'device.resume', 'device.clockSource', 'device.directMonitor', 'latency.measure', 'engine.capabilities', 'engine.configure', 'engine.snapshot', 'engine.close', 'transport.play', 'transport.pause', 'transport.stop', 'transport.seek', 'note.preview', 'note.on', 'note.off', 'note.allOff', 'monitor.set', 'record.start', 'record.stop', 'record.commit', 'render.wav', 'output.test', 'device.controlPanel', 'devices.controlPanel', 'asset.put', 'samples.register', 'project.set', 'plugins.scan', 'plugins.list', 'plugins.parameters', 'plugins.parameter', 'plugins.editor', 'plugins.state'])

function record(value: unknown, label = 'request'): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid native audio ${label}.`)
  return value as Json
}
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`)
  return value
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`)
  return value
}
/** `record.start { takes: [{ trackId }] }`: only track IDs cross from the renderer; paths are created here. */
function recordingTracks(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TAKES) throw new Error('Invalid recording takes.')
  const ids = value.map(item => text(record(item, 'recording take').trackId, 'track ID'))
  if (new Set(ids).size !== ids.length) throw new Error('한 트랙에는 녹음 테이크를 하나만 만들 수 있습니다.')
  return ids
}
interface ActiveTake { id: string; trackId: string; path: string }

/** Control process and private asset transport. No live audio buffer crosses this service. */
export class NativeAudioService {
  private child: ChildProcessWithoutNullStreams | null = null
  private launching: Promise<void> | null = null
  private initialized: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private sequence = 0
  private generation = 0
  private output = ''
  private diagnostics = ''
  private poll: NodeJS.Timeout | null = null
  private polling = false
  private disposed = false
  private directory = ''
  private recordingDirectory = ''
  /** One recording at a time; `legacy` answers in the former single-take shape. */
  private activeTakes: { takes: ActiveTake[]; legacy: boolean } | null = null
  private takes = new Map<string, string>()
  private catalog: CatalogEntry[] = []
  private catalogLoaded = false
  private scanPending = false

  constructor(private readonly options: NativeAudioOptions) {}

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const root = join(this.options.profileDirectory, 'native-audio')
      await mkdir(root, { recursive: true, mode: 0o700 })
      this.directory = await mkdtemp(join(root, 'session-'))
      this.recordingDirectory = join(root, 'recovery')
      await mkdir(this.recordingDirectory, { recursive: true, mode: 0o700 })
    })()
  }

  private async start(): Promise<void> {
    if (this.disposed) throw new Error('네이티브 오디오 엔진이 종료되었습니다.')
    if (this.launching) return this.launching
    if (this.child) return
    this.launching = (async () => {
      await this.initialize()
      const info = await stat(this.options.executable).catch(() => null)
      if (!info?.isFile()) throw new Error('설치 파일에 네이티브 오디오 엔진이 없습니다. 앱을 다시 설치하거나 native:build를 실행해주세요.')
      const child = spawn(this.options.executable, ['--protocol', ...(this.options.testClock ? ['--test-clock'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: dirname(this.options.executable) })
      this.child = child
      this.generation++
      this.output = ''; this.diagnostics = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { if (this.child === child) this.consume(chunk) })
      child.stderr.on('data', (chunk: string) => { if (this.child === child) this.diagnostics = (this.diagnostics + chunk).slice(-8192) })
      child.stdin.on('error', error => { this.failed(child, error); child.kill() })
      child.on('error', error => this.failed(child, error))
      child.on('exit', (code, signal) => this.failed(child, new Error(`네이티브 오디오 엔진이 종료되었습니다 (${signal ?? code ?? 'unknown'}). 장치 설정에서 다시 연결해주세요.`)))
      const hello = record(await this.send('hello', {}, 15_000), 'handshake')
      if (hello.protocol !== 1) { child.kill(); throw new Error('네이티브 엔진과 앱의 프로토콜 버전이 다릅니다.') }
      this.options.onState({ type: 'state', ready: false, playing: false, generation: this.generation })
      this.poll = setInterval(() => {
        // Offline rendering can occupy the control thread for several minutes.
        // A short status timeout must not abort that acknowledged operation.
        if (this.polling || this.pending.size || !this.child || this.disposed) return
        this.polling = true
        void this.send('engine.snapshot', {}, 5000).then(value => {
          const state = record(value, 'snapshot')
          this.options.onState({ ...state, type: 'state', generation: this.generation })
        }).catch(error => this.options.onState({ type: 'error', error: error.message, generation: this.generation })).finally(() => { this.polling = false })
      }, 40)
      this.poll.unref()
    })().catch(error => {
      if (this.child) { const child = this.child; this.failed(child, error); child.kill() }
      throw error
    }).finally(() => { this.launching = null })
    return this.launching
  }

  private failed(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return
    this.child = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
    this.options.onState({ type: 'error', ready: false, playing: false, error: error.message, generation: this.generation })
    // Recording files deliberately survive a crash for recovery.
    this.activeTakes = null
  }

  private consume(chunk: string): void {
    this.output += chunk
    if (Buffer.byteLength(this.output) > MAX_MESSAGE_BYTES) { this.child?.kill(); return }
    for (let newline = this.output.indexOf('\n'); newline >= 0; newline = this.output.indexOf('\n')) {
      const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1)
      let message: Json
      try { message = record(JSON.parse(line), 'response') } catch { this.diagnostics = (this.diagnostics + line).slice(-8192); continue }
      if (typeof message.id !== 'number') continue
      const request = this.pending.get(message.id)
      if (!request) continue
      this.pending.delete(message.id); clearTimeout(request.timer)
      if (message.ok === true) request.resolve(message.result)
      else { const problem = typeof message.error === 'string' ? message.error : (message.error as Json | undefined)?.message; request.reject(new Error(typeof problem === 'string' ? problem : '네이티브 오디오 요청이 실패했습니다.')) }
    }
  }

  private send(method: string, params: Json, timeout = 30_000): Promise<unknown> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error('네이티브 오디오 엔진에 연결되지 않았습니다.'))
    if (this.pending.size >= 64) return Promise.reject(new Error('오디오 명령이 너무 많습니다. 잠시 후 다시 시도해주세요.'))
    const id = ++this.sequence
    const line = JSON.stringify({ id, method, params }) + '\n'
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return Promise.reject(new Error('오디오 프로젝트 명령이 허용 크기를 초과했습니다.'))
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation must never finish later against a new UI state.
        // Terminate the unresponsive host and retain unfinished recording files.
        const error = new Error(`오디오 엔진 응답 시간이 초과되었습니다: ${method}`)
        this.failed(child, error); child.kill()
      }, timeout)
      this.pending.set(id, { resolve: resolveResult, reject, timer })
      child.stdin.write(line, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) } })
    })
  }

  private async loadCatalog(): Promise<void> {
    if (this.catalogLoaded) return
    const file = join(this.options.profileDirectory, 'native-audio', 'plugins.json')
    try {
      const values: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(values)) throw new Error('Invalid catalog')
      this.catalog = values.filter((x): x is CatalogEntry => !!x && typeof x === 'object' && typeof x.pluginId === 'string' && typeof x.classId === 'string' && typeof x.path === 'string' && extname(x.path).toLowerCase() === '.vst3')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('VST3 목록 파일을 읽을 수 없습니다. 목록을 복구해주세요.') }
    this.catalogLoaded = true
  }

  private publicPlugin(entry: CatalogEntry): Omit<CatalogEntry, 'path'> {
    const { path: _path, ...safe } = entry
    return safe
  }

  private async resolveTimeline(value: unknown): Promise<Json> {
    const timeline = structuredClone(record(value, 'timeline'))
    if (!Array.isArray(timeline.tracks) || timeline.tracks.length > 256) throw new Error('Invalid timeline tracks.')
    await this.loadCatalog()
    const resolvePlugin = (input: unknown, enabled: boolean) => {
      const plugin = record(input, 'plugin')
      const selected = this.catalog.find(entry => entry.pluginId === plugin.pluginId && entry.classId === plugin.classId)
      if (!selected && enabled) throw new Error(`승인된 VST3를 찾을 수 없습니다: ${typeof plugin.name === 'string' ? plugin.name : 'unknown'}. 플러그인 목록에서 연결해주세요.`)
      // No path from a project/renderer is ever accepted as a loadable module.
      const { path: _discard, ...safe } = plugin
      return { ...safe, path: selected?.path ?? '' }
    }
    for (const item of timeline.tracks) {
      const track = record(item, 'track'), source = record(track.source, 'source')
      if (source.kind === 'vst3') source.plugin = resolvePlugin(source.plugin, track.enabled !== false)
      if (Array.isArray(track.inserts)) for (const item of track.inserts) { const insert = record(item, 'insert'); if (insert.type === 'vst3') insert.plugin = resolvePlugin(insert.plugin, track.enabled !== false && insert.enabled !== false) }
    }
    return timeline
  }

  private async scanPlugin(): Promise<unknown> {
    if (this.scanPending) throw new Error('플러그인 검사가 진행 중입니다.')
    this.scanPending = true
    try {
      await this.initialize(); await this.loadCatalog()
      const selected = await this.options.selectPlugin()
      if (!selected) return []
      const path = await realpath(selected)
      if (extname(path).toLowerCase() !== '.vst3') throw new Error('.vst3 플러그인을 선택해주세요.')
      // The scanner is disposable: a broken plugin never loads in Electron or the active audio host.
      const results = await new Promise<unknown[]>((resolveResult, reject) => {
        const child = spawn(this.options.executable, ['--scan-plugin', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = '', errors = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('VST3 검사가 30초 내에 완료되지 않아 중단했습니다.')) }, 30_000)
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', (part: string) => { output += part; if (output.length > 2 * 1024 * 1024) child.kill() })
        child.stderr.on('data', (part: string) => { errors = (errors + part).slice(-4096) })
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => {
          clearTimeout(timer)
          if (code !== 0) { reject(new Error(`VST3 검사가 실패했습니다 (${code}). ${errors.slice(-500)}`)); return }
          try {
            const line = output.trim().split('\n').reverse().find(line => line.startsWith('{'))
            const result = record(JSON.parse(line ?? ''), 'plugin scan')
            if (!Array.isArray(result.plugins)) throw new Error('Invalid scan response')
            resolveResult(result.plugins)
          } catch { reject(new Error('VST3 검사 결과가 올바르지 않습니다.')) }
        })
      })
      const additions = results.map(item => {
        const plugin = record(item, 'plugin descriptor')
        const classId = text(plugin.classId, 'class ID', 64)
        return { ...plugin, path, classId, pluginId: createHash('sha256').update(path + '\0' + classId).digest('hex'), name: text(plugin.name, 'plugin name'), vendor: typeof plugin.vendor === 'string' ? plugin.vendor : '', isInstrument: plugin.isInstrument === true } as CatalogEntry
      })
      this.catalog = [...this.catalog.filter(item => item.path !== path), ...additions]
      const destination = join(this.options.profileDirectory, 'native-audio', 'plugins.json')
      const temporary = `${destination}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(this.catalog), { mode: 0o600 }); await rename(temporary, destination)
      return additions.map(entry => this.publicPlugin(entry))
    } finally { this.scanPending = false }
  }

  private async pcmAsset(params: Json): Promise<unknown> {
    const id = text(params.id, 'asset ID')
    const sampleRate = integer(params.sampleRate, 8000, 192000, 'PCM sample rate')
    if (!Array.isArray(params.channels) || !params.channels.length || params.channels.length > 32) throw new Error('Invalid PCM channels.')
    const channels = params.channels as Float32Array[]
    if (!channels.every(channel => channel instanceof Float32Array)) throw new Error('PCM channels must be Float32Array.')
    const frames = channels[0].length
    if (!frames || frames * channels.length * 4 > MAX_PCM_BYTES || !channels.every(channel => channel.length === frames)) throw new Error('PCM asset size is invalid.')
    const data = Buffer.allocUnsafe(frames * channels.length * 4)
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels.length; channel++) {
      const value = channels[channel][frame]
      if (!Number.isFinite(value)) throw new Error('오디오에 유효하지 않은 샘플이 있습니다.')
      data.writeFloatLE(value, (frame * channels.length + channel) * 4)
    }
    const path = join(this.directory, `${randomUUID()}.f32`)
    try {
      await writeFile(path, data, { mode: 0o600, flag: 'wx' })
      return await this.send('asset.load', { id, path, sampleRate, channels: channels.length, frames })
    } finally { await rm(path, { force: true }).catch(() => {}) }
  }

  async request(methodInput: unknown, paramsInput: unknown = {}): Promise<unknown> {
    const method = text(methodInput, 'method')
    if (!METHODS.has(method)) throw new Error('허용되지 않은 네이티브 오디오 요청입니다.')
    const params = paramsInput === undefined ? {} : record(paramsInput)
    if ('path' in params || 'executable' in params) throw new Error('오디오 제어 명령에 파일 경로를 전달할 수 없습니다.')
    if (method === 'note.preview' && !(typeof params.trackId === 'string' && params.trackId.length)) {
      const source = record(params.source, 'preview source')
      if (source.kind !== 'builtin-synth' && source.kind !== 'builtin-sampled') throw new Error('독립 미리듣기는 내장 악기에만 사용할 수 있습니다.')
    }
    if (method === 'plugins.scan') return this.scanPlugin()
    if (method === 'plugins.list') { await this.initialize(); await this.loadCatalog(); return this.catalog.map(entry => this.publicPlugin(entry)) }
    if (method === 'record.commit') {
      const id = text(params.takeId, 'take ID'), path = this.takes.get(id)
      if (path) { await rm(path, { force: true }); this.takes.delete(id) }
      return {}
    }
    await this.start()
    // Discover the running host's instrument support without opening an audio
    // device. The renderer must not infer WAVE support from Electron alone.
    if (method === 'engine.capabilities') return this.send('hello', {})
    if (method === 'engine.close') { const result = await this.send(method, params); this.activeTakes = null; return result }
    if (method === 'asset.put') return this.pcmAsset(params)
    if (method === 'engine.configure' && Number(params.inputChannels) > 0 && !(await this.options.allowInput())) throw new Error('오디오 입력 사용이 허용되지 않았습니다.')
    if ((method === 'latency.measure' || (method === 'monitor.set' && params.enabled === true)) && !(await this.options.allowInput())) throw new Error('오디오 입력 사용이 허용되지 않았습니다.')
    if (method === 'project.set') return this.send(method, { ...params, timeline: await this.resolveTimeline(params.timeline) })
    if (method === 'record.start') {
      if (this.activeTakes) throw new Error('이미 녹음 중입니다.')
      const legacy = !('takes' in params)
      const trackIds = legacy ? [text(params.trackId, 'track ID')] : recordingTracks(params.takes)
      if (!(await this.options.allowInput())) throw new Error('오디오 입력 사용이 허용되지 않았습니다.')
      const takes = trackIds.map((trackId): ActiveTake => { const id = randomUUID(); return { id, trackId, path: join(this.recordingDirectory, `${id}.wav`) } })
      const request = legacy ? { ...params, path: takes[0].path, takeId: takes[0].id } : { takes: takes.map(take => ({ trackId: take.trackId, takeId: take.id, path: take.path })) }
      let result: Json
      try { result = record(await this.send(method, request), 'recording') }
      catch (error) {
        // A refused start has captured nothing; do not leave empty headers in the recovery folder.
        await Promise.all(takes.map(take => rm(take.path, { force: true }).catch(() => {})))
        throw error
      }
      this.activeTakes = { takes, legacy }
      for (const take of takes) this.takes.set(take.id, take.path)
      const reported = Array.isArray(result.takes) ? result.takes.map(item => { const { path: _path, ...take } = record(item, 'recording take'); return take }) : []
      if (legacy) { const { takes: _takes, path: _path, ...single } = result; return { ...single, takeId: takes[0].id } }
      return { ...result, takes: reported }
    }
    if (method === 'record.stop') {
      if (!this.activeTakes) throw new Error('진행 중인 녹음이 없습니다.')
      const active = this.activeTakes
      const result = record(await this.send(method, params), 'recording')
      this.activeTakes = null
      const reported = Array.isArray(result.takes) ? result.takes.map(item => record(item, 'recording take')) : []
      if (active.legacy) {
        const take = active.takes[0]
        const info = await stat(take.path)
        if (info.size > MAX_PCM_BYTES) throw new Error('녹음 파일이 프로젝트의 크기 한도를 넘었습니다. 복구 폴더에 원본을 보관했습니다.')
        const data = new Uint8Array(await readFile(take.path))
        const { path: _path, takes: _takes, ...metadata } = result
        return { ...metadata, data, name: `Recording-${take.id}.wav`, takeId: take.id }
      }
      let budget = MAX_TAKES_BYTES
      const takes = []
      for (const take of active.takes) {
        const { path: _path, ...metadata } = reported.find(item => item.takeId === take.id) ?? { error: '네이티브 엔진이 이 테이크의 결과를 보내지 않았습니다. 복구 폴더를 확인해주세요.' }
        const size = (await stat(take.path).catch(() => null))?.size ?? 0
        // One oversized take must not discard the others: report it and keep its file for recovery.
        if (size > MAX_PCM_BYTES || size > budget) { takes.push({ ...metadata, data: new Uint8Array(0), name: `Recording-${take.id}.wav`, takeId: take.id, trackId: take.trackId, error: '녹음 파일이 전송 크기 한도를 넘었습니다. 복구 폴더에 원본을 보관했습니다.' }); continue }
        budget -= size
        const data = size ? new Uint8Array(await readFile(take.path)) : new Uint8Array(0)
        takes.push({ ...metadata, data, name: `Recording-${take.id}.wav`, takeId: take.id, trackId: take.trackId })
      }
      return { takes, sampleRate: result.sampleRate }
    }
    if (method === 'render.wav') {
      const path = join(this.directory, `${randomUUID()}.wav`)
      try {
        const result = record(await this.send(method, { ...params, timeline: await this.resolveTimeline(params.timeline), path }, 10 * 60_000), 'render')
        const info = await stat(path)
        if (info.size > MAX_PCM_BYTES) throw new Error('WAV 파일이 전송 크기 한도를 넘었습니다.')
        const { path: _path, ...metadata } = result
        return { ...metadata, data: new Uint8Array(await readFile(path)) }
      } finally { await rm(path, { force: true }).catch(() => {}) }
    }
    // Native host paths are supplied exclusively above, not by the renderer.
    return this.send(method, params)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    const child = this.child
    if (child) {
      try { await this.send('engine.close', {}, 3000) } catch { /* Crash recovery keeps unfinished recordings. */ }
      child.stdin.end()
      await new Promise<void>(resolveResult => {
        const timer = setTimeout(() => { child.kill(); resolveResult() }, 1500)
        child.once('exit', () => { clearTimeout(timer); resolveResult() })
      })
      this.failed(child, new Error('오디오 엔진을 종료했습니다.'))
    }
    if (this.directory && resolve(this.directory).startsWith(`${resolve(this.options.profileDirectory)}${sep}`)) await rm(this.directory, { recursive: true, force: true }).catch(() => {})
  }
}
