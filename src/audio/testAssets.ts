import type { AudioAsset } from '../core/types'
import { assetPcmCache, createAudioAsset, type AssetPcmCache } from './assetPcm'

/** Test helpers: an AudioBuffer-shaped PCM and an asset whose PCM is already cached (no decoder needed). */
export function fakePcm(channels: readonly (readonly number[] | Float32Array)[], sampleRate = 48000): AudioBuffer {
  const data = channels.map(channel => channel instanceof Float32Array ? channel : Float32Array.from(channel))
  const length = data[0]?.length ?? 0
  return { sampleRate, numberOfChannels: data.length, length, duration: length / sampleRate, getChannelData: (channel: number) => data[channel] } as unknown as AudioBuffer
}

export function testAsset(id: string, pcm: AudioBuffer, blob: Blob = new Blob(['original']), cache: AssetPcmCache = assetPcmCache): AudioAsset {
  return createAudioAsset(id, id, blob, pcm, cache)
}
