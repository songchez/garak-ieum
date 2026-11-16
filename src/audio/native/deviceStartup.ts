import type { AudioSettings } from '../../core/audioSettings'
import type { NativeBackend, NativeDevice, NativeErrorCode } from './contracts'
import { nativeErrorCode } from './deviceErrors'

/**
 * Launch-time device connection policy (docs/NATIVE_AUDIO.md, "시작할 때 장치 연결").
 *
 * The saved settings are always tried first. Transient driver failures (busy, still
 * initialising after boot, host restarted) are retried with backoff; a device that cannot
 * work as saved falls back along a fixed chain. A fallback is a session-only choice: the
 * saved preference is never overwritten, so the next launch tries it again.
 *
 * Everything here is pure; NativeAudioEngine.autoStart runs the plan through the same
 * engine.configure path that the settings dialog's 적용 uses.
 */
export type StartupStep = 'preferred' | 'driverBuffer' | 'defaultDevice' | 'platformDefault'
export interface StartupCandidate { step: StartupStep; backend: NativeBackend; settings: AudioSettings }
export type StartupErrorKind = 'transient' | 'buffer' | 'device'
export type StartupDecision = { kind: 'retry'; delayMs: number } | { kind: 'next'; index: number } | { kind: 'fail' }
export interface StartupLogEntry { /** Milliseconds since the launch connection began. */ ms: number; step: string; detail: string; ok?: boolean }
/** The launch connection as 설정 › 상태·진단 and 진단 복사 show it. */
export interface NativeStartupReport {
  state: 'running' | 'ready' | 'fallback' | 'failed' | 'cancelled'
  startedAt: number
  preferred: string
  /** The configuration that is running (null until one started). */
  used: string | null
  /** Why the saved configuration was not used (fallback/failed only). */
  reason: string | null
  /** The saved device was missing from the driver's list, so its return can be detected. */
  preferredMissing: boolean
  notice: string | null
  log: StartupLogEntry[]
}

/** Backoff per attempt: ~6 s for the saved device (a driver still starting after boot), one quick retry for fallbacks. */
export const STARTUP_RETRY_DELAYS: Readonly<Record<'preferred' | 'fallback', readonly number[]>> = { preferred: [400, 800, 1600, 3200], fallback: [500] }

export const platformBackend = (platform: string): NativeBackend | null => platform === 'win32' ? 'wasapi' : platform === 'darwin' ? 'coreaudio' : null

/** Like nativeBackendForPlatform, but null instead of throwing for a backend this OS lacks. */
export function startupBackend(settings: AudioSettings, platform: string): NativeBackend | null {
  const fallback = platformBackend(platform)
  if (!fallback) return null
  if (settings.nativeBackend === 'auto') return fallback
  return (platform === 'darwin') === (settings.nativeBackend === 'coreaudio') ? settings.nativeBackend : null
}

const deviceKey = (candidate: StartupCandidate) => JSON.stringify([candidate.backend, candidate.settings.outputDeviceId, candidate.settings.inputDeviceId, candidate.settings.nativeBufferFrames, candidate.settings.clockSource ?? null])

/** The ordered configurations to try: saved → saved with the driver's buffer → same backend's default device → OS default. */
export function startupCandidates(preferred: AudioSettings, platform: string): StartupCandidate[] {
  const result: StartupCandidate[] = []
  const add = (candidate: StartupCandidate) => { if (!result.some(item => deviceKey(item) === deviceKey(candidate))) result.push(candidate) }
  const backend = startupBackend(preferred, platform), osDefault = platformBackend(platform)
  const defaults = (settings: AudioSettings, next: NativeBackend): AudioSettings => {
    const { clockSource: _clock, ...rest } = settings
    return { ...rest, nativeBackend: next === osDefault && settings.nativeBackend === 'auto' ? 'auto' : next, inputDeviceId: '', outputDeviceId: '', nativeBufferFrames: 'driver', directMonitoring: false }
  }
  if (backend) {
    add({ step: 'preferred', backend, settings: preferred })
    if (preferred.nativeBufferFrames !== 'driver') add({ step: 'driverBuffer', backend, settings: { ...preferred, nativeBufferFrames: 'driver' } })
    // ASIO has no "default" driver; trying another installed one would be a guess.
    if (backend !== 'asio') add({ step: 'defaultDevice', backend, settings: defaults(preferred, backend) })
  }
  if (osDefault) add({ step: 'platformDefault', backend: osDefault, settings: defaults(preferred, osDefault) })
  return result
}

/** Without opening anything: the device list says the saved device is gone (or ASIO has none selected). */
export function missingDevice(candidate: StartupCandidate, devices: readonly NativeDevice[] | null): boolean {
  const id = candidate.settings.outputDeviceId
  if (candidate.backend === 'asio' && !id) return true
  if (!id || !devices) return false
  return !devices.some(device => device.id === id)
}

const TRANSIENT_CODES: ReadonlySet<NativeErrorCode> = new Set(['DEVICE_IN_USE', 'DRIVER_INIT_FAILED', 'DEVICE_LOST'])
/** Host-side conditions that pass by themselves: a restarted/slow host process. */
const TRANSIENT_TEXT = /응답 시간이 초과|엔진이 종료|연결되지 않았습니다|명령이 너무 많습니다/

export function classifyStartupError(error: unknown): StartupErrorKind {
  const code = nativeErrorCode(error)
  if (code) return TRANSIENT_CODES.has(code) ? 'transient' : code === 'BUFFER_UNSUPPORTED' ? 'buffer' : 'device'
  if (error instanceof Error && error.name === 'AbortError') return 'transient'
  return TRANSIENT_TEXT.test(error instanceof Error ? error.message : String(error)) ? 'transient' : 'device'
}

/** What to do after `attempt` (1-based) of candidates[index] failed with `error`. */
export function decideStartup(candidates: readonly StartupCandidate[], index: number, attempt: number, error: unknown): StartupDecision {
  const kind = classifyStartupError(error)
  const delays = STARTUP_RETRY_DELAYS[index === 0 ? 'preferred' : 'fallback']
  if (kind === 'transient' && attempt <= delays.length) return { kind: 'retry', delayMs: delays[attempt - 1] }
  // A buffer refusal may still work at the driver's own size; any other failure is about the device itself.
  const next = candidates.findIndex((candidate, at) => at > index && (kind === 'buffer' || candidate.step !== 'driverBuffer'))
  return next < 0 ? { kind: 'fail' } : { kind: 'next', index: next }
}

export const backendLabel = (backend: string): string => backend === 'asio' ? 'ASIO' : backend === 'wasapi' ? 'WASAPI' : backend === 'coreaudio' ? 'Core Audio' : backend === 'test' ? '테스트 클록' : backend

const REASONS: Record<NativeErrorCode, string> = {
  DEVICE_NOT_FOUND: '장치를 찾지 못했습니다',
  DEVICE_IN_USE: '다른 앱이 장치를 사용 중입니다',
  DRIVER_INIT_FAILED: '드라이버를 시작하지 못했습니다',
  SAMPLE_RATE_UNSUPPORTED: '장치가 프로젝트 샘플레이트를 지원하지 않습니다',
  BUFFER_UNSUPPORTED: '드라이버가 저장된 버퍼 크기를 받지 않습니다',
  CHANNELS_UNAVAILABLE: '장치의 채널 구성이 바뀌었습니다',
  DEVICE_LOST: '장치 연결이 끊어졌습니다',
}
/** A short Korean reason for a toast or the diagnostics log. */
export function startupReason(error: unknown): string {
  const code = nativeErrorCode(error)
  if (code) return REASONS[code]
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim()
  return text.length > 120 ? `${text.slice(0, 117)}…` : text || '알 수 없는 오류'
}

/** "ASIO · Focusrite USB ASIO", or the backend's default device. */
export function candidateLabel(candidate: StartupCandidate, name?: string | null): string {
  const id = candidate.settings.outputDeviceId
  return `${backendLabel(candidate.backend)} · ${id ? name || '저장된 출력 장치' : '기본 장치'}`
}

/** The one launch notice: what changed and why, or null when the saved settings started as they are. */
export function startupNotice(input: { preferred: StartupCandidate; used: StartupCandidate | null; error: unknown; preferredName?: string | null }): string | null {
  const { preferred, used, error } = input
  const reason = startupReason(error)
  if (!used) return `오디오 장치를 자동으로 연결하지 못했습니다 — ${reason}. 설정에서 장치를 확인해 주세요.`
  if (used.step === 'preferred') return null
  if (used.step === 'driverBuffer') return `저장된 I/O 버퍼(${preferred.settings.nativeBufferFrames} 프레임)를 드라이버가 받지 않아 드라이버 권장 버퍼로 연결했습니다. 저장된 설정은 그대로 두었습니다.`
  return `저장된 오디오 장치(${candidateLabel(preferred, input.preferredName)})를 열지 못해 ${candidateLabel(used)}로 연결했습니다 — ${reason}. 저장된 설정은 그대로 두고 다음 실행 때 다시 시도합니다.`
}
