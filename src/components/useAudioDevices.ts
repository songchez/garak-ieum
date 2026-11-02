import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AudioDeviceProbe, audioDeviceError } from '../audio/AudioDeviceProbe'
import type { AudioProbeSnapshot } from '../audio/AudioDeviceProbe'
import { inputConstraints } from '../core/audioSettings'
import type { AudioSettings, SampleRate } from '../core/audioSettings'

type OutputSelectionDevices = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>
}

export interface AudioDevicesState {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
  loading: boolean
  error: string | null
  supportedConstraints: MediaTrackSupportedConstraints
  canSelectOutput: boolean
  refresh: () => Promise<void>
  requestInputAccess: () => Promise<void>
  chooseOutput: (currentId?: string) => Promise<MediaDeviceInfo | null>
  test: AudioProbeSnapshot
  startInputTest: () => Promise<void>
  stopInputTest: () => void
}

const mediaDevices = (): OutputSelectionDevices | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.mediaDevices as OutputSelectionDevices | undefined

/** Enumerating is passive; only explicit button actions request device access. */
export function useAudioDevices(settings: AudioSettings, sampleRate?: SampleRate): AudioDevicesState {
  const [probe] = useState(() => new AudioDeviceProbe())
  const test = useSyncExternalStore(probe.subscribe, probe.getSnapshot, probe.getSnapshot)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [accessLoading, setAccessLoading] = useState(false)
  const [outputLoading, setOutputLoading] = useState(false)
  const active = useRef(false)
  const lifecycle = useRef(0)
  const listRequest = useRef(0)
  const accessRequest = useRef(0)
  const outputRequest = useRef(0)
  const constraints = inputConstraints(settings, sampleRate)
  const captureKey = JSON.stringify(constraints)
  const currentCapture = useRef({ key: captureKey, constraints })
  currentCapture.current = { key: captureKey, constraints }

  const supportedConstraints = useMemo(() => {
    try { return mediaDevices()?.getSupportedConstraints() ?? {} } catch { return {} }
  }, [])
  const canSelectOutput = typeof mediaDevices()?.selectAudioOutput === 'function'

  const refresh = useCallback(async () => {
    if (!active.current) return
    const epoch = lifecycle.current
    const request = ++listRequest.current
    const current = () => active.current && lifecycle.current === epoch && listRequest.current === request
    setListLoading(true)
    try {
      const devices = mediaDevices()
      if (!devices?.enumerateDevices) throw new DOMException('Audio device enumeration is unavailable.', 'NotSupportedError')
      const list = await devices.enumerateDevices()
      if (!current()) return
      setInputs(list.filter(device => device.kind === 'audioinput'))
      setOutputs(list.filter(device => device.kind === 'audiooutput'))
      setError(null)
    } catch (error) {
      if (current()) setError(audioDeviceError(error))
    } finally {
      if (current()) setListLoading(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    lifecycle.current += 1
    const devices = mediaDevices()
    const changed = () => { void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    devices?.addEventListener('devicechange', changed)
    document.addEventListener('visibilitychange', visible)
    void refresh()
    return () => {
      active.current = false
      lifecycle.current += 1
      listRequest.current += 1
      accessRequest.current += 1
      outputRequest.current += 1
      devices?.removeEventListener('devicechange', changed)
      document.removeEventListener('visibilitychange', visible)
      probe.dispose()
    }
  }, [probe, refresh])

  useEffect(() => {
    probe.configure(currentCapture.current.constraints)
    accessRequest.current += 1
    setAccessLoading(false)
  }, [probe, captureKey])

  const requestInputAccess = useCallback(async () => {
    if (!active.current) return
    const epoch = lifecycle.current
    const request = ++accessRequest.current
    const key = currentCapture.current.key
    const current = () => active.current && lifecycle.current === epoch && accessRequest.current === request && currentCapture.current.key === key
    setError(null)
    setAccessLoading(true)
    try {
      // Enumeration happens while the temporary track is still live, then its lease is released.
      // If the meter is active, this borrows its stream without opening or stopping another one.
      await probe.requestAccess(currentCapture.current.constraints, refresh)
    } catch (error) {
      if (current()) setError(audioDeviceError(error))
    } finally {
      if (current()) setAccessLoading(false)
    }
  }, [probe, refresh])

  const chooseOutput = useCallback(async (currentId?: string): Promise<MediaDeviceInfo | null> => {
    if (!active.current) return null
    const devices = mediaDevices()
    if (!devices?.selectAudioOutput) {
      setError('이 브라우저에서는 출력 장치 선택 창을 열 수 없습니다. 사용 가능한 장치를 고르거나 운영체제의 기본 출력을 변경해주세요.')
      return null
    }
    const epoch = lifecycle.current
    const request = ++outputRequest.current
    const current = () => active.current && lifecycle.current === epoch && outputRequest.current === request
    setError(null)
    setOutputLoading(true)
    try {
      // Do not await enumeration/permission before this call: it needs the button's activation.
      const device = await devices.selectAudioOutput(currentId ? { deviceId: currentId } : {})
      if (!current()) return null
      await refresh()
      return current() ? device : null
    } catch (error) {
      if (current()) setError(audioDeviceError(error))
      return null
    } finally {
      if (current()) setOutputLoading(false)
    }
  }, [refresh])

  const startInputTest = useCallback(async () => {
    if (!active.current) return
    const epoch = lifecycle.current
    const key = currentCapture.current.key
    await probe.start(currentCapture.current.constraints)
    if (active.current && lifecycle.current === epoch && currentCapture.current.key === key && probe.getSnapshot().status === 'active') await refresh()
  }, [probe, refresh])
  const stopInputTest = useCallback(() => probe.stop(), [probe])

  return {
    inputs, outputs, loading: listLoading || accessLoading || outputLoading, error,
    supportedConstraints, canSelectOutput, refresh, requestInputAccess, chooseOutput,
    test, startInputTest, stopInputTest,
  }
}
