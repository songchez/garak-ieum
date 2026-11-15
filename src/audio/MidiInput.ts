import type { NativeLiveMidi } from './native/nativeLiveMidi'

/**
 * MIDI input devices (Settings › 오디오/MIDI). Browser: Web MIDI (`navigator.requestMIDIAccess`), messages go to the
 * engine's live MIDI port with their DOM timestamps. Desktop: the native host opens the devices (WinMM / CoreMIDI)
 * and delivers messages straight to its audio thread; this service only lists and enables them.
 * docs/MIDI_RECORDING.md.
 */
export type MidiAccessState = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied' | 'error'
export interface MidiDeviceInfo { id: string; name: string; manufacturer?: string; connected: boolean; enabled: boolean }
export interface MidiInputState { access: MidiAccessState; devices: readonly MidiDeviceInfo[]; error?: string }
export type MidiSink = (source: string, data: readonly number[], timeStampMs: number) => void

export interface MidiInputService {
  readonly kind: 'web' | 'native'
  getState(): MidiInputState
  subscribe(listener: () => void): () => void
  /** Asks for access (browser permission prompt) and lists devices. Safe to call again (refresh). */
  requestAccess(): Promise<void>
  setEnabled(deviceId: string, enabled: boolean): void
  dispose(): void
}

const STORAGE_KEY = 'garak.midiInputs.disabled'
/** Disabled device names (ids change between sessions and machines); every other device is on. */
export function loadDisabledMidiInputs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 256) : [])
  } catch { return new Set() }
}
export function saveDisabledMidiInputs(names: ReadonlySet<string>, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify([...names])) } catch { /* Private mode: the choice lasts for this session. */ }
}

abstract class BaseService {
  protected state: MidiInputState
  private listeners = new Set<() => void>()
  protected disabled = loadDisabledMidiInputs()
  constructor(access: MidiAccessState) { this.state = { access, devices: [] } }
  getState(): MidiInputState { return this.state }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  protected publish(patch: Partial<MidiInputState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
  protected remember(name: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(name)
    else this.disabled.add(name)
    saveDisabledMidiInputs(this.disabled)
  }
}

type MidiNavigator = Navigator & { requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess> }

export class WebMidiInputService extends BaseService implements MidiInputService {
  readonly kind = 'web' as const
  private access: MIDIAccess | null = null
  private attached = new Map<string, MIDIInput>()
  private disposed = false

  constructor(private readonly sink: MidiSink, private readonly nav: MidiNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator as MidiNavigator) {
    super(nav?.requestMIDIAccess ? 'idle' : 'unsupported')
    if (this.state.access === 'unsupported') this.state = { ...this.state, error: '이 브라우저는 Web MIDI를 지원하지 않습니다. Chrome·Edge 또는 데스크톱 앱을 사용하세요.' }
    else void this.autoRequest()
  }

  /** A permission granted earlier opens devices at start-up without a prompt. */
  private async autoRequest(): Promise<void> {
    try {
      const status = await this.nav?.permissions?.query({ name: 'midi' as PermissionName })
      if (status?.state === 'granted') await this.requestAccess()
    } catch { /* Browsers without the midi permission name wait for an explicit request. */ }
  }

  async requestAccess(): Promise<void> {
    if (!this.nav?.requestMIDIAccess || this.disposed) return
    if (this.access) { this.refresh(); return }
    this.publish({ access: 'requesting', error: undefined })
    try {
      const access = await this.nav.requestMIDIAccess({ sysex: false })
      if (this.disposed) return
      this.access = access
      access.onstatechange = () => this.refresh()
      this.refresh()
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'SecurityError' || error.name === 'NotAllowedError')
      this.publish({ access: denied ? 'denied' : 'error', error: denied ? 'MIDI 장치 접근이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 MIDI 권한을 허용한 뒤 다시 시도하세요.' : `MIDI 장치를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  /** Hot-plug: rebuild the list and (de)attach listeners. */
  private refresh(): void {
    const access = this.access
    if (!access || this.disposed) return
    const devices: MidiDeviceInfo[] = []
    const live = new Set<string>()
    access.inputs.forEach(input => {
      const name = input.name || input.id
      const connected = input.state !== 'disconnected'
      const enabled = !this.disabled.has(name)
      devices.push({ id: input.id, name, manufacturer: input.manufacturer || undefined, connected, enabled })
      if (connected && enabled) {
        live.add(input.id)
        if (!this.attached.has(input.id)) {
          input.onmidimessage = event => { if (event.data) this.sink(input.id, Array.from(event.data), event.timeStamp) }
          this.attached.set(input.id, input)
        }
      }
    })
    for (const [id, input] of this.attached) if (!live.has(id)) { input.onmidimessage = null; this.attached.delete(id) }
    this.publish({ access: 'ready', devices, error: undefined })
  }

  setEnabled(deviceId: string, enabled: boolean): void {
    const device = this.state.devices.find(item => item.id === deviceId)
    if (!device) return
    this.remember(device.name, enabled)
    this.refresh()
  }

  dispose(): void {
    this.disposed = true
    for (const input of this.attached.values()) input.onmidimessage = null
    this.attached.clear()
    if (this.access) this.access.onstatechange = null
  }
}

/** Desktop: polls the host's device list (WinMM has no hot-plug callback) and keeps the enabled set in sync. */
export class NativeMidiInputService extends BaseService implements MidiInputService {
  readonly kind = 'native' as const
  private timer: ReturnType<typeof setInterval> | null = null
  private known = ''
  private busy = false

  constructor(private readonly port: Pick<NativeLiveMidi, 'listDevices' | 'enableDevices'>, private readonly intervalMs = 2000) {
    super('idle')
    void this.requestAccess()
    this.timer = setInterval(() => { void this.poll() }, intervalMs)
  }

  async requestAccess(): Promise<void> { await this.poll(true) }

  private async poll(explicit = false): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (explicit && this.state.access !== 'ready') this.publish({ access: 'requesting' })
      let list = await this.port.listDevices()
      if (!list.supported) { this.publish({ access: 'unsupported', devices: [], error: '이 네이티브 엔진은 MIDI 입력을 지원하지 않습니다.' }); return }
      const wanted = list.devices.filter(device => !this.disabled.has(device.name)).map(device => device.id)
      if (list.devices.some(device => device.enabled !== wanted.includes(device.id))) list = await this.port.enableDevices(wanted)
      const devices = list.devices.map(device => ({ id: device.id, name: device.name, connected: true, enabled: device.enabled }))
      const key = JSON.stringify(devices)
      if (key !== this.known || this.state.access !== 'ready') { this.known = key; this.publish({ access: 'ready', devices, error: undefined }) }
    } catch (error) {
      // The engine is not running yet (no audio device): try again on the next poll.
      if (explicit || this.state.access === 'ready') this.publish({ access: 'idle', error: `MIDI 장치 목록을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}` })
    } finally { this.busy = false }
  }

  setEnabled(deviceId: string, enabled: boolean): void {
    const device = this.state.devices.find(item => item.id === deviceId)
    if (!device) return
    this.remember(device.name, enabled)
    this.publish({ devices: this.state.devices.map(item => item.id === deviceId ? { ...item, enabled } : item) })
    void this.poll()
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}

/**
 * The active service's device list for views that are not wired to it (track inspector MIDI input menu).
 * useMidiPerformance publishes into it; nothing else writes it.
 */
let directory: readonly MidiDeviceInfo[] = []
const directoryListeners = new Set<() => void>()
export const midiDeviceDirectory = {
  get: (): readonly MidiDeviceInfo[] => directory,
  subscribe(listener: () => void): () => void { directoryListeners.add(listener); return () => { directoryListeners.delete(listener) } },
  publish(devices: readonly MidiDeviceInfo[]): void {
    if (devices === directory) return
    directory = devices
    for (const listener of [...directoryListeners]) listener()
  },
}
