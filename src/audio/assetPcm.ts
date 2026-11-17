import type { AudioAsset, Project } from '../core/types'
import { buildWaveformPyramid, pyramidBytes } from '../core/waveformPyramid'

/**
 * On-demand PCM of audio assets (docs/ARCHITECTURE.md "오디오 자산 메모리").
 *
 * An `AudioAsset` keeps its original bytes, metadata and peaks; its samples are decoded from `blob` when
 * something needs them (an engine upload, pitch/warp/tempo analysis, normalize, a close-zoom waveform)
 * and kept in a small LRU cache that also lets go of entries nobody touched for a while. Callers hold the
 * returned AudioBuffer only for the work at hand, so the engine's copy is the only long-lived one.
 */

/** Decodes encoded audio at `sampleRate` (the rate the asset was first decoded at). */
export type PcmDecoder = (bytes: ArrayBuffer, sampleRate: number) => Promise<AudioBuffer>

const OVERVIEW_POINTS = 320

/** The 320-point overview: each point is the largest of up to 256 evenly strided frames per channel. */
export function overviewPeaks(channels: readonly Float32Array[], length: number): number[] {
  const peaks: number[] = []
  const count = Math.min(OVERVIEW_POINTS, length)
  for (let point = 0; point < count; point += 1) {
    const start = Math.floor(point * length / count)
    const end = Math.floor((point + 1) * length / count)
    const stride = Math.max(1, Math.floor((end - start) / 256))
    let peak = 0
    for (const channel of channels) {
      for (let frame = start; frame < end; frame += stride) peak = Math.max(peak, Math.abs(channel[frame]))
    }
    peaks.push(Math.min(1, peak))
  }
  return peaks
}

const channelsOf = (buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>) =>
  Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))

/** Bytes of float32 PCM an AudioBuffer holds. */
export const pcmBytes = (buffer: Pick<AudioBuffer, 'numberOfChannels' | 'length'>) => buffer.numberOfChannels * buffer.length * 4

/**
 * An asset from freshly decoded PCM: metadata, overview and pyramid. The PCM goes into `cache` (the work
 * that follows a decode — an engine upload, tempo analysis, channel picking — reads it from there) and is
 * not referenced by the asset.
 */
export function createAudioAsset(id: string, name: string, blob: Blob, buffer: AudioBuffer, cache: AssetPcmCache | null = assetPcmCache): AudioAsset {
  const channels = channelsOf(buffer)
  const asset: AudioAsset = {
    id, name, blob,
    sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels, length: buffer.length, duration: buffer.duration,
    peaks: overviewPeaks(channels, buffer.length),
    pyramid: buildWaveformPyramid(channels, buffer.sampleRate),
  }
  cache?.seed(asset, buffer)
  return asset
}

const decodeContexts = new Map<number, OfflineAudioContext>()

/** The browser's decoder; an OfflineAudioContext never opens an output device. */
export const decodeWithOfflineContext: PcmDecoder = (bytes, sampleRate) => {
  let context = decodeContexts.get(sampleRate)
  if (!context) { context = new OfflineAudioContext(1, 1, sampleRate); decodeContexts.set(sampleRate, context) }
  return context.decodeAudioData(bytes)
}

export interface AssetPcmCacheOptions {
  /** Bytes of PCM kept for reuse; the most recently used entry stays even when it alone is larger. */
  budgetBytes?: number
  /** Entries unused this long are dropped (0 keeps them until evicted by the budget). */
  idleMs?: number
  decode?: PcmDecoder
  now?: () => number
}

interface Entry { buffer: AudioBuffer; bytes: number; used: number }

export const DEFAULT_PCM_BUDGET_BYTES = 192 * 1024 * 1024
export const DEFAULT_PCM_IDLE_MS = 20_000

export class AssetPcmCache {
  /** Insertion order is recency: the first entry is the least recently used. */
  private readonly entries = new Map<AudioAsset, Entry>()
  private readonly pending = new Map<AudioAsset, Promise<AudioBuffer>>()
  private held = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly budget: number
  private readonly idle: number
  private readonly now: () => number
  decode: PcmDecoder
  /** Decodes performed (tests and diagnostics). */
  decodes = 0

  constructor(options: AssetPcmCacheOptions = {}) {
    this.budget = Math.max(0, options.budgetBytes ?? DEFAULT_PCM_BUDGET_BYTES)
    this.idle = Math.max(0, options.idleMs ?? DEFAULT_PCM_IDLE_MS)
    this.decode = options.decode ?? decodeWithOfflineContext
    this.now = options.now ?? (() => Date.now())
  }

  /** The asset's PCM, decoded from its bytes unless cached (concurrent requests share one decode). */
  get(asset: AudioAsset): Promise<AudioBuffer> {
    const hit = this.peek(asset)
    if (hit) return Promise.resolve(hit)
    const pending = this.pending.get(asset)
    if (pending) return pending
    const task = (async () => {
      let bytes: ArrayBuffer
      try { bytes = await asset.blob.arrayBuffer() } catch { throw new Error(`'${asset.name}' 원본 바이트를 읽지 못했습니다.`) }
      this.decodes += 1
      let buffer: AudioBuffer
      try { buffer = await this.decode(bytes, asset.sampleRate) } catch { throw new Error(`'${asset.name}' 원본을 다시 디코드하지 못했습니다.`) }
      if (buffer.length !== asset.length || buffer.numberOfChannels !== asset.numberOfChannels || buffer.sampleRate !== asset.sampleRate)
        throw new Error(`'${asset.name}' 원본을 다시 디코드한 결과가 처음과 다릅니다.`)
      return buffer
    })()
    this.pending.set(asset, task)
    void task.then(buffer => { if (this.pending.get(asset) === task) { this.pending.delete(asset); this.seed(asset, buffer) } },
      () => { if (this.pending.get(asset) === task) this.pending.delete(asset) })
    return task
  }

  /** The cached PCM, if any (marks it recently used). */
  peek(asset: AudioAsset): AudioBuffer | undefined {
    const entry = this.entries.get(asset)
    if (!entry) return undefined
    this.entries.delete(asset)
    entry.used = this.now()
    this.entries.set(asset, entry)
    return entry.buffer
  }

  /** Caches PCM the caller already has (a fresh decode). */
  seed(asset: AudioAsset, buffer: AudioBuffer): void {
    this.drop(asset)
    const bytes = pcmBytes(buffer)
    this.entries.set(asset, { buffer, bytes, used: this.now() })
    this.held += bytes
    this.trim()
    this.arm()
  }

  /** Forgets an asset's PCM (a discarded intermediate decode). */
  release(asset: AudioAsset): void {
    this.pending.delete(asset)
    this.drop(asset)
  }

  clear(): void {
    this.entries.clear(); this.pending.clear(); this.held = 0
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  /** Drops entries idle longer than `idleMs` (the timer calls it; tests may too). */
  sweep(): void {
    if (!this.idle) return
    const limit = this.now() - this.idle
    for (const [asset, entry] of [...this.entries]) if (entry.used <= limit) this.drop(asset)
  }

  get size(): number { return this.entries.size }
  get bytes(): number { return this.held }

  private drop(asset: AudioAsset): void {
    const entry = this.entries.get(asset)
    if (!entry) return
    this.entries.delete(asset)
    this.held -= entry.bytes
  }

  private trim(): void {
    for (const asset of this.entries.keys()) {
      if (this.held <= this.budget || this.entries.size <= 1) break
      this.drop(asset)
    }
  }

  private arm(): void {
    if (!this.idle || this.timer !== null || !this.entries.size) return
    this.timer = setTimeout(() => { this.timer = null; this.sweep(); this.arm() }, this.idle)
    ;(this.timer as { unref?: () => void }).unref?.()
  }
}

/** The app's cache. */
export const assetPcmCache = new AssetPcmCache()

/** The asset's PCM, decoded on demand (hold it only for the work at hand). */
export function assetPcm(asset: AudioAsset): Promise<AudioBuffer> {
  return assetPcmCache.get(asset)
}

/** Channel views of the asset's PCM, for code that works on Float32Array channels. */
export async function assetChannels(asset: AudioAsset): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  const buffer = await assetPcm(asset)
  return { sampleRate: buffer.sampleRate, channels: channelsOf(buffer) }
}

/** Assets a project plays: audio regions and frozen renders. */
export function referencedAssetIds(project: Project): Set<string> {
  return new Set(project.tracks.flatMap(track => [...track.clips.flatMap(clip => clip.kind === 'audio' ? [clip.assetId] : []), ...(track.render?.frozen ? [track.render.frozen.assetId] : [])]))
}

/** What the main thread holds for `assets` (bytes): original bytes, peaks and pyramids, and cached PCM. */
export function assetMemory(assets: Iterable<AudioAsset>, cache: AssetPcmCache = assetPcmCache): { blobs: number; peaks: number; cachedPcm: number; total: number } {
  let blobs = 0, peaks = 0
  for (const asset of assets) {
    blobs += asset.blob.size
    peaks += asset.peaks.length * 8 + (asset.pyramid ? pyramidBytes(asset.pyramid) : 0)
  }
  return { blobs, peaks, cachedPcm: cache.bytes, total: blobs + peaks + cache.bytes }
}
