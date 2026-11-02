const TEST_FREQUENCY = 440
const TEST_GAIN = 0.025
const TEST_DURATION = 0.45
const FADE_IN = 0.015
const FADE_OUT = 0.035

/** A short tone on the applied output; owns only its own nodes, never the shared context. */
export function playOutputTest(getContext: () => Promise<AudioContext>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let context: AudioContext | null = null
    let sinkId: unknown
    let oscillator: OscillatorNode | null = null
    let gain: GainNode | null = null

    const cleanup = (stop: boolean) => {
      signal.removeEventListener('abort', aborted)
      context?.removeEventListener('statechange', stateChanged)
      context?.removeEventListener('sinkchange', sinkChanged)
      context?.removeEventListener('error', outputFailed)
      if (oscillator) {
        oscillator.onended = null
        if (stop) { try { oscillator.stop() } catch { /* not started or already stopped */ } }
        try { oscillator.disconnect() } catch { /* already disconnected */ }
      }
      try { gain?.disconnect() } catch { /* already disconnected */ }
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup(true)
      reject(error)
    }
    const ended = () => {
      if (settled) return
      settled = true
      cleanup(false)
      resolve()
    }
    const aborted = () => fail(new DOMException('출력 테스트를 취소했습니다.', 'AbortError'))
    const stateChanged = () => {
      if (context?.state !== 'running') fail(new Error('출력 장치가 중지되어 테스트를 마치지 못했습니다. 장치를 확인하고 다시 테스트해주세요.'))
    }
    const actualSink = () => (context as (AudioContext & { sinkId?: unknown }) | null)?.sinkId
    const sinkChanged = () => {
      if (actualSink() !== sinkId) fail(new Error('출력 장치가 변경되어 테스트를 중지했습니다. 선택한 장치를 확인하고 다시 테스트해주세요.'))
    }
    const outputFailed = () => fail(new Error('출력 장치에 문제가 발생해 테스트를 중지했습니다. 연결과 권한을 확인해주세요.'))

    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      // Invoke synchronously so the engine can resume within the button's user activation.
      void getContext().then(value => {
        if (settled || signal.aborted) return
        context = value
        try {
          if (context.state !== 'running') throw new Error('오디오 장치가 실행 중이 아닙니다. 출력 테스트를 다시 시작해주세요.')
          sinkId = actualSink()
          context.addEventListener('statechange', stateChanged)
          context.addEventListener('sinkchange', sinkChanged)
          context.addEventListener('error', outputFailed)
          oscillator = context.createOscillator()
          gain = context.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = TEST_FREQUENCY
          gain.gain.value = 0
          const start = context.currentTime
          const end = start + TEST_DURATION
          gain.gain.setValueAtTime(0, start)
          gain.gain.linearRampToValueAtTime(TEST_GAIN, start + FADE_IN)
          gain.gain.setValueAtTime(TEST_GAIN, end - FADE_OUT)
          gain.gain.linearRampToValueAtTime(0, end)
          oscillator.connect(gain)
          gain.connect(context.destination)
          oscillator.onended = ended
          oscillator.start(start)
          if (!settled) oscillator.stop(end)
        } catch (error) { fail(error) }
      }, fail)
    } catch (error) { fail(error) }
  })
}
