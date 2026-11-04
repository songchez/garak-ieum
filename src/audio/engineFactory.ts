import { getDesktopBridge } from '../platform/desktop'
import type { AudioSettings } from '../core/audioSettings'
import { WebAudioEngine } from './WebAudioEngine'
import { NativeAudioEngine } from './native/NativeAudioEngine'
import type { NativeAudioBridge } from './native/contracts'

/** A missing/broken native host never silently switches desktop playback to Web Audio. */
export function createAudioEngine(settings: AudioSettings, desktop = getDesktopBridge()): WebAudioEngine | NativeAudioEngine {
  if (desktop) {
    const bridge = (desktop as typeof desktop & { audio?: NativeAudioBridge }).audio
    return new NativeAudioEngine(bridge, desktop.platform, undefined, settings)
  }
  // A failed preload can remove the entire bridge, not just audio.request.
  // Electron still must fail closed; its user agent is only a runtime detector,
  // never an authority for IPC or filesystem access.
  if (typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent)) return new NativeAudioEngine(undefined, 'unavailable', undefined, settings)
  return new WebAudioEngine(undefined, settings)
}
