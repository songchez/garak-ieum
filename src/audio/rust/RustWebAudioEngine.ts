import { DEFAULT_AUDIO_SETTINGS, projectSampleRate, type AudioSettings } from '../../core/audioSettings'
import { playbackProject } from '../../core/freeze'
import type { MetronomeEngineState, PlayOptions } from '../../core/metronome'
import type { AudioAsset, Project, RenderOptions, RenderedAudio, TransportSnapshot } from '../../core/types'
import { tempoMapOf } from '../../core/tempoMap'
import type { TakeCallbacks } from '../../core/recording'
import type { RouteRecordings } from '../RouteRecording'
import { trackTailSeconds } from '../graph'
import { clamp, loopRange, normalizedStart } from '../math'
import { packAudioBuffer } from '../native/pcmTransfer'
import { compileNativeTimeline, NativeTimelineCompiler, type NativePcmAsset, type NativeProjectTimeline } from '../native/timeline'
import { encodeTracks, planNativeSync, type SyncTimeline } from '../native/timelineSync'
import { encodeWav } from '../wavEncode'
import { WebAudioEngine } from '../WebAudioEngine'
import { emptyStatus, type EngineStatus } from './engineChannel'
import { renderInEngineWorker, RustEngineNode, sharedGarakEngineModule } from './engineHost'
import type { EngineRenderAsset } from './engineOffline'
import { GarakEngineError, utf8Encode } from './garakEngineWasm'

const CLICK_INTERVAL_MS = 25
const CLICK_LOOKAHEAD_SECONDS = 0.12
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** What the page is doing with the Rust engine (tests, the smoke script and bug reports). */
export interface RustEngineDiagnostics {
  /** The worklet node exists on the current audio context. */
  running: boolean
  /** Status and transport use a SharedArrayBuffer (cross-origin isolated page). */
  sharedChannel: boolean
  /** The engine accepted the current project; otherwise `reason` says why it plays on Web Audio. */
  accepted: boolean
  reason: string
  /** Which renderer the transport is playing on right now. */
  playing: 'rust' | 'web-audio' | null
  status: EngineStatus
  /** The last offline render (export/bounce/freeze/stems). */
  lastRender: { engine: 'rust' | 'web-audio'; renderMs?: number; frames: number; reason?: string } | null
}

/** PCM referenced by a playback project's audio clips and frozen renders. */
function referencedAssets(project: Project): Set<string> {
  return new Set(project.tracks.flatMap(track => [...track.clips.flatMap(clip => clip.kind === 'audio' ? [clip.assetId] : []), ...(track.render?.frozen ? [track.render.frozen.assetId] : [])]))
}

const pcmMetadata = (id: string, buffer: AudioBuffer): NativePcmAsset => ({ id, sampleRate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels })

/**
 * The web app on the unified Rust render engine (docs/RUST_ENGINE.md 5), behind `rustEngineRequested()`.
 *
 * Everything that makes a project sound — clips, effect chains, sends/returns, automation, tempo map,
 * master — renders in one AudioWorklet running garak-engine.wasm, fed by the same render-diff
 * protocol the desktop host receives (NativeTimelineCompiler + planNativeSync: project.set, then
 * project.patch per edit). Export/bounce renders the same engine in a Worker.
 *
 * It is a WebAudioEngine: device setup, decoding, sample libraries, recording, previews and live MIDI
 * stay there, and any project the engine refuses (it says why: instrument tracks until they are
 * ported, frozen renders, guitar rig, ...) plays and exports on the Web Audio graph with a console
 * note. The engine is asked again after every edit, so newly supported features switch over on their
 * own. While the engine plays, no Web Audio graph is kept (it is rebuilt on pause/stop for previews);
 * input/route monitoring and route recording need that graph and keep a project on Web Audio while
 * they are on.
 */
export class RustWebAudioEngine extends WebAudioEngine {
  private bridge: RustEngineNode | null = null
  private readonly compiler = new NativeTimelineCompiler()
  /** The last timeline the engine accepted on this bridge (patches are planned against it). */
  private synced: SyncTimeline | null = null
  private timelineRevision = 0
  private projectRevision = 0
  private syncedRevision = -1
  private syncTask: Promise<void> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private verdict = { accepted: false, reason: '아직 Rust 엔진에 프로젝트를 보내지 않았습니다.' }
  private uploaded = new Map<string, WeakRef<AudioBuffer>>()
  private rustPlaying = false
  /** Sequence number of the last play/seek command; status before it is stale. */
  private transportSeq = 0
  private playRequest = 0
  private status: EngineStatus = emptyStatus()
  private peak = 0
  private forceWebAudio = false
  private monitorActive = false
  private routeMonitorActive = false
  private routeRecording = false
  private clickTimer: ReturnType<typeof setInterval> | null = null
  private clickBeat = 0
  private clickTime = 0
  private readonly notes = new Set<string>()
  private lastRender: RustEngineDiagnostics['lastRender'] = null

  constructor(project?: Project, settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) {
    // The base constructor would call setProject before this class's fields exist.
    super(undefined, settings)
    if (project) this.setProject(project)
  }

  diagnostics(): RustEngineDiagnostics {
    if (this.bridge) this.poll()
    return {
      running: !!this.bridge && this.bridge.context === this.context && !this.bridge.error,
      sharedChannel: !!this.bridge?.sharedChannel,
      accepted: this.verdict.accepted, reason: this.verdict.reason,
      playing: this.rustPlaying ? 'rust' : this.playing ? 'web-audio' : null,
      status: { ...this.status }, lastRender: this.lastRender,
    }
  }

  private note(text: string): void {
    if (this.notes.has(text)) return
    this.notes.add(text)
    console.info(`[가락이음] Rust 엔진: ${text}`)
  }

  /** The engine renders the current project now (else the Web Audio graph does). */
  private rustActive(): boolean {
    return !!this.bridge && !this.bridge.error && this.bridge.context === this.context && this.verdict.accepted && !this.forceWebAudio
      && !this.monitorActive && !this.routeMonitorActive && !this.routeRecording
  }

  /** The Web Audio graph exists except while the engine plays (previews, monitoring and a fallback need it when stopped). */
  protected override graphEnabled(): boolean { return this.playing || !this.rustPlaying }

  protected override async prepareContext(context: AudioContext): Promise<void> {
    const module = await sharedGarakEngineModule()
    if (!module) { this.note('garak-engine.wasm이 없어 Web Audio 엔진을 씁니다 (pnpm rust:wasm으로 빌드).'); return }
    try {
      const bridge = await RustEngineNode.create(context, module)
      this.bridge?.dispose()
      this.bridge = bridge
      this.synced = null
      this.uploaded.clear()
      this.syncedRevision = -1
      this.status = emptyStatus()
      this.verdict = { accepted: false, reason: '아직 Rust 엔진에 프로젝트를 보내지 않았습니다.' }
      this.scheduleSync()
    } catch (error) {
      this.note(`워크릿을 시작하지 못해 Web Audio 엔진을 씁니다: ${message(error)}`)
    }
  }

  override setProject(source: Project): void {
    super.setProject(source)
    this.projectRevision += 1
    this.scheduleSync()
  }

  override setAssets(assets: Map<string, AudioAsset>): void {
    super.setAssets(assets)
    this.projectRevision += 1
    this.scheduleSync()
  }

  private scheduleSync(): void {
    if (!this.bridge || this.syncTimer !== null) return
    // Coalesces a burst of edits (a fader drag) into one patch, like the native engine.
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncNow().catch(error => this.note(`프로젝트 동기화 실패: ${message(error)}`))
    }, 16)
  }

  private syncNow(): Promise<void> {
    if (this.syncTask) return this.syncTask
    const task = (async () => {
      while (this.bridge && this.project && this.syncedRevision !== this.projectRevision) {
        const bridge = this.bridge, revision = this.projectRevision
        await this.syncOnce(bridge, this.project)
        if (bridge !== this.bridge) return
        this.syncedRevision = revision
      }
    })()
    this.syncTask = task
    void task.finally(() => { if (this.syncTask === task) this.syncTask = null }).catch(() => undefined)
    return task
  }

  private async syncOnce(bridge: RustEngineNode, project: Project): Promise<void> {
    const reject = (reason: string) => { this.synced = null; this.setVerdict(false, reason) }
    if (bridge.error) return reject(bridge.error)
    if (project.sampleRate !== bridge.context.sampleRate) return reject(`프로젝트 ${project.sampleRate} Hz와 오디오 장치 ${bridge.context.sampleRate} Hz가 다릅니다.`)
    const metadata = new Map<string, NativePcmAsset>()
    const referenced = referencedAssets(project)
    try {
      for (const id of referenced) {
        const asset = this.assets.get(id)
        if (!asset) return reject(`오디오 자산을 찾을 수 없습니다: ${id}`)
        if (this.uploaded.get(id)?.deref() !== asset.buffer) {
          await bridge.putAsset(id, asset.buffer)
          this.uploaded.set(id, new WeakRef(asset.buffer))
        }
        metadata.set(id, pcmMetadata(id, asset.buffer))
      }
      // PCM nothing references any more leaves the worklet (graphs still using it keep it until rebuilt).
      for (const id of [...this.uploaded.keys()]) if (!referenced.has(id)) { this.uploaded.delete(id); void bridge.removeAsset(id).catch(() => undefined) }
    } catch (error) {
      return reject(message(error))
    }
    let timeline: NativeProjectTimeline
    try { timeline = this.compiler.compile(project, metadata, ++this.timelineRevision) } catch (error) { return reject(message(error)) }
    const plan = planNativeSync(this.synced, timeline)
    try {
      await bridge.update(plan.method, plan.method === 'project.set' ? (plan.params as { timeline: unknown }).timeline : plan.params, plan.binary)
      if (bridge !== this.bridge) return
      this.synced = timeline
      this.setVerdict(true, '')
    } catch (error) {
      if (bridge !== this.bridge) return
      // A refused patch leaves the engine on its previous project: the next sync sends project.set.
      reject(message(error))
    }
  }

  private setVerdict(accepted: boolean, reason: string): void {
    const changed = accepted !== this.verdict.accepted
    this.verdict = { accepted, reason }
    if (!accepted) this.note(`이 프로젝트는 Web Audio 엔진으로 재생합니다: ${reason}`)
    if (changed && !accepted && this.rustPlaying) this.handOff(reason)
  }

  /** Something needs the Web Audio graph (monitoring, route recording): move playback there. */
  private pinChanged(why: string): void {
    if (this.rustPlaying && !this.rustActive()) this.handOff(why)
  }

  /** Continues the playing transport on the Web Audio graph from the heard beat. */
  private handOff(reason: string): void {
    if (!this.rustPlaying) return
    const beat = this.rustBeat()
    this.bridge?.transport('pause')
    this.rustPlaying = false
    this.stopClicks()
    this.position = beat
    this.note(`재생을 Web Audio 엔진으로 넘깁니다: ${reason}`)
    this.forceWebAudio = true
    this.refreshGraph()
    void super.play().catch(error => this.note(`Web Audio 엔진으로 재생하지 못했습니다: ${message(error)}`))
  }

  override async play(options: PlayOptions = {}): Promise<void> {
    if (this.rustPlaying) return
    if (!this.project || this.playing) return super.play(options)
    this.forceWebAudio = false
    const request = ++this.playRequest
    await this.resume()
    if (request !== this.playRequest) return
    if (this.bridge && this.bridge.context === this.context) await this.syncNow()
    if (request !== this.playRequest || !this.project || this.rustPlaying || this.playing) return
    if ((options.countInBars ?? 0) > 0) {
      // The engine has no scheduled start yet; a count-in (recording) plays on Web Audio.
      this.forceWebAudio = this.rustActive() || this.forceWebAudio
      this.refreshGraph()
    }
    if (!this.rustActive()) {
      if (this.bridge && !this.verdict.accepted) this.note(`이 프로젝트는 Web Audio 엔진으로 재생합니다: ${this.verdict.reason}`)
      this.refreshGraph()
      return super.play(options)
    }
    const bridge = this.bridge!, project = this.project, context = this.context!
    let beat = normalizedStart(project, this.position)
    if (!loopRange(project) && beat >= project.lengthBeats) beat = 0
    this.position = beat
    bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(beat, project.sampleRate)))
    this.transportSeq = bridge.transport('play')
    this.rustPlaying = true
    // No idle Web Audio graph (and its effect worklets) runs next to the engine.
    this.refreshGraph()
    this.startClicks(beat, context.currentTime)
    this.publishSnapshot()
  }

  override pause(): void {
    this.playRequest += 1
    if (!this.rustPlaying) {
      this.forceWebAudio = false
      super.pause()
      return
    }
    const beat = this.rustBeat()
    this.bridge?.transport('pause')
    this.rustPlaying = false
    this.stopClicks()
    super.pause()
    this.position = beat
    this.publishSnapshot()
  }

  override stop(): void {
    this.playRequest += 1
    if (this.rustPlaying) this.bridge?.transport('stop')
    this.rustPlaying = false
    this.forceWebAudio = false
    this.routeRecording = false
    this.stopClicks()
    super.stop()
  }

  override seek(beat: number): void {
    if (!this.rustPlaying || !this.project || !this.bridge || !this.context) { super.seek(beat); return }
    const project = this.project
    this.position = clamp(beat, 0, project.lengthBeats)
    this.transportSeq = this.bridge.transport('seek', Math.round(tempoMapOf(project).frameAt(this.position, project.sampleRate)))
    this.startClicks(this.position, this.context.currentTime)
    this.publishSnapshot()
  }

  override setMetronome(state: MetronomeEngineState): void {
    super.setMetronome(state)
    if (this.rustPlaying && this.context) this.startClicks(this.rustBeat(), this.context.currentTime)
  }

  override setInputMonitor(stream: MediaStream | null, trackIds: readonly string[]): void {
    this.monitorActive = !!stream && trackIds.length > 0
    this.pinChanged('입력 모니터링은 Web Audio 그래프를 씁니다.')
    super.setInputMonitor(stream, trackIds)
  }

  override setRouteMonitor(trackIds: readonly string[]): void {
    this.routeMonitorActive = trackIds.length > 0
    this.pinChanged('트랙 입력 모니터링은 Web Audio 그래프를 씁니다.')
    super.setRouteMonitor(trackIds)
  }

  override async prepareRouteRecording(): Promise<void> {
    this.routeRecording = true
    this.pinChanged('트랙 라우트 녹음은 Web Audio 그래프를 씁니다.')
    return super.prepareRouteRecording()
  }

  override createRouteRecordings(trackIds: readonly string[], callbacks: TakeCallbacks): RouteRecordings {
    this.routeRecording = true
    this.pinChanged('트랙 라우트 녹음은 Web Audio 그래프를 씁니다.')
    return super.createRouteRecordings(trackIds, callbacks)
  }

  protected override currentBeat(): number {
    return this.rustPlaying ? this.rustBeat() : super.currentBeat()
  }

  private poll(): EngineStatus {
    if (this.bridge) {
      const status = this.bridge.readStatus()
      this.peak = Math.max(this.peak, status.peak)
      this.status = status
    }
    return this.status
  }

  /** The engine's transport beat (the start beat until the last play/seek has been applied). */
  private rustBeat(): number {
    const project = this.project
    if (!project) return this.position
    const status = this.poll()
    if (status.appliedSeq < this.transportSeq) return this.position
    return clamp(tempoMapOf(project).beatAtFrame(status.frame, project.sampleRate), 0, project.lengthBeats)
  }

  protected override publishSnapshot(): void {
    if (!this.rustPlaying) { super.publishSnapshot(); return }
    const status = this.poll()
    if (status.appliedSeq >= this.transportSeq && !status.playing) {
      // The engine reached the project end (no cycle): tails ring out, the transport rests there.
      this.rustPlaying = false
      this.stopClicks()
      this.position = this.project?.lengthBeats ?? this.position
      super.publishSnapshot()
      return
    }
    this.publishAudioState()
    const next: TransportSnapshot = {
      playing: true,
      beat: Math.round(this.rustBeat() * 10000) / 10000,
      ready: this.context?.state === 'running',
      sampleRate: this.context?.sampleRate ?? 0,
    }
    if (next.beat === this.snapshot.beat && this.snapshot.playing && next.ready === this.snapshot.ready && next.sampleRate === this.snapshot.sampleRate) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  protected override readIdleMeters(): void {
    if (!this.bridge || !this.rustActive()) { super.readIdleMeters(); return }
    this.poll()
    // The engine publishes the master peak only; per-track meters arrive with the engine's track taps.
    this.masterLevel = Math.max(this.peak, this.masterLevel * 0.7)
    this.peak = 0
    this.levels.clear()
  }

  /** Metronome clicks on the audio clock while the engine plays (monitor only, like Web Audio). */
  private startClicks(beat: number, now: number): void {
    this.metronome.cancel(now)
    this.clickBeat = beat
    this.clickTime = now + 0.003
    this.clickTimer ??= setInterval(() => this.scheduleClicks(), CLICK_INTERVAL_MS)
    this.scheduleClicks()
  }

  private stopClicks(): void {
    if (this.clickTimer !== null) clearInterval(this.clickTimer)
    this.clickTimer = null
    this.metronome.cancel(this.context?.currentTime ?? 0)
  }

  private scheduleClicks(): void {
    const context = this.context, project = this.project
    if (!context || !project || !this.rustPlaying) { this.stopClicks(); return }
    // A trigger from the scheduler keeps the transport snapshot fresh between base ticks too.
    const loop = loopRange(project), tempo = tempoMapOf(project), boundary = loop?.end ?? project.lengthBeats
    const horizon = context.currentTime + CLICK_LOOKAHEAD_SECONDS
    if (this.clickTime < context.currentTime - CLICK_LOOKAHEAD_SECONDS) { this.clickBeat = this.rustBeat(); this.clickTime = context.currentTime }
    for (let iterations = 0; this.clickTime < horizon && iterations < 128; iterations++) {
      if (this.clickBeat >= boundary - 0.0000001) {
        if (!loop) break
        this.clickBeat = loop.start
      }
      const remaining = tempo.secondsBetween(this.clickBeat, boundary)
      const segment = Math.min(horizon - this.clickTime, remaining)
      if (segment <= 0.00000001) break
      const end = segment >= remaining ? boundary : Math.min(boundary, tempo.beatAfter(this.clickBeat, segment))
      this.metronome.scheduleSegment(context, project, this.clickBeat, end, this.clickTime)
      this.clickTime += segment
      this.clickBeat = end
    }
  }

  /** Export, bounce, freeze and stems on the engine in a Worker; refused projects render on Web Audio. */
  override async renderAudio(source: Project, options: RenderOptions): Promise<RenderedAudio> {
    const fallback = async (reason: string): Promise<RenderedAudio> => {
      this.note(`이 렌더는 Web Audio 엔진으로 합니다: ${reason}`)
      const result = await super.renderAudio(source, options)
      this.lastRender = { engine: 'web-audio', frames: result.frames, reason }
      return result
    }
    // The engine has no master bypass yet (C++ RenderEngine::setMasterBypass).
    if (options.preMaster) return fallback('마스터 이전(pre-master) 렌더는 아직 지원하지 않습니다.')
    const module = await sharedGarakEngineModule()
    if (!module) return fallback('garak-engine.wasm이 없습니다.')
    const project = playbackProject(source, this.assets)
    const sampleRate = projectSampleRate(project.sampleRate)
    const metadata = new Map<string, NativePcmAsset>()
    const assets: EngineRenderAsset[] = []
    for (const id of referencedAssets(project)) {
      const asset = this.assets.get(id)
      if (!asset) return fallback(`오디오 자산을 찾을 수 없습니다: ${id}`)
      metadata.set(id, pcmMetadata(id, asset.buffer))
      // One interleaved copy per export, transferred to the worker.
      const pcm = packAudioBuffer(asset.buffer)
      assets.push({ id, sampleRate: pcm.sampleRate, channels: pcm.channels, samples: new Float32Array(pcm.data.buffer, pcm.data.byteOffset, pcm.frames * pcm.channels) })
    }
    let timeline: NativeProjectTimeline
    try { timeline = compileNativeTimeline(project, metadata) } catch (error) { return fallback(message(error)) }
    if (timeline.lengthFrames > sampleRate * 60 * 15) throw new Error('이 초기 버전은 한 번에 최대 15분까지 WAV로 내보낼 수 있습니다. 프로젝트 길이를 줄여 주세요.')
    const encoded = encodeTracks(timeline.tracks)
    let result
    try {
      result = await renderInEngineWorker(module, {
        timeline: utf8Encode(JSON.stringify({ ...timeline, tracks: encoded.tracks })), binary: encoded.binary ?? undefined,
        sampleRate, lengthFrames: timeline.lengthFrames, assets,
        tailSeconds: options.tailSeconds === undefined ? undefined : Math.min(30, Math.max(0, options.tailSeconds)),
        startFrame: options.startFrame,
      })
    } catch (error) {
      if (error instanceof GarakEngineError) return fallback(error.message)
      throw error
    }
    this.lastRender = { engine: 'rust', renderMs: result.renderMs, frames: result.frames }
    return { blob: encodeWav([result.left, result.right], sampleRate, options.bitDepth), sampleRate, frames: result.frames, tailSeconds: result.tailSeconds, trackTailSeconds: trackTailSeconds(project) }
  }

  override dispose(): void {
    this.playRequest += 1
    this.stopClicks()
    if (this.syncTimer !== null) clearTimeout(this.syncTimer)
    this.syncTimer = null
    this.rustPlaying = false
    this.bridge?.dispose()
    this.bridge = null
    this.synced = null
    this.uploaded.clear()
    super.dispose()
  }
}
