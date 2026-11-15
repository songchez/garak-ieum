import { useEffect, useRef, useState } from 'react'
import { deviceAnalysisTap, type DeviceAnalysisTap } from '../../../devices/effects/analysis'
import { freqToUnit } from './scale'

/** The analysis tap of a device, re-resolved while mounted (the audio graph may be rebuilt). */
export function useAnalysisTap(deviceId: string, enabled: boolean): DeviceAnalysisTap | undefined {
  const [tap, setTap] = useState<DeviceAnalysisTap | undefined>(() => enabled ? deviceAnalysisTap(deviceId) : undefined)
  useEffect(() => {
    if (!enabled) { setTap(undefined); return }
    const check = () => setTap(previous => { const next = deviceAnalysisTap(deviceId); return next === previous ? previous : next })
    check()
    const timer = window.setInterval(check, 800)
    return () => window.clearInterval(timer)
  }, [deviceId, enabled])
  return tap
}

const FLOOR = -96
/** Analyzer display tilt (dB/oct around 1 kHz), as in Pro-Q, so pink-ish music looks level. */
const TILT = 4.5

/**
 * Drives a filled spectrum path at ~30 fps without React renders. The path spans the plot width;
 * dBFS FLOOR…0 maps to the plot's full height. Columns take the loudest bin they cover, then a
 * light peak-hold decay keeps the motion calm.
 */
export function useSpectrumPath(tap: DeviceAnalysisTap | undefined, width: number, height: number, fill: React.RefObject<SVGPathElement | null>, line: React.RefObject<SVGPathElement | null>): void {
  const state = useRef<{ data: Float32Array<ArrayBuffer>; hold: Float32Array } | null>(null)
  useEffect(() => {
    const fillEl = fill.current, lineEl = line.current
    if (!tap || !fillEl || !lineEl || width < 10 || height < 10) { fillEl?.setAttribute('d', ''); lineEl?.setAttribute('d', ''); return }
    const { analyser, sampleRate } = tap
    const columns = Math.max(24, Math.min(320, Math.round(width / 3)))
    state.current = { data: new Float32Array(analyser.frequencyBinCount), hold: new Float32Array(columns).fill(FLOOR) }
    // Bin range per column, precomputed.
    const binHz = sampleRate / analyser.fftSize
    const ranges = Array.from({ length: columns }, (_, c) => {
      const lo = 20 * Math.pow(1000, c / columns), hi = 20 * Math.pow(1000, (c + 1) / columns)
      const center = Math.sqrt(lo * hi)
      return { a: Math.max(1, Math.floor(lo / binHz)), b: Math.max(1, Math.ceil(hi / binHz)), x: freqToUnit(center) * width, tilt: TILT * Math.log2(center / 1000) }
    })
    let frame = 0, last = 0, silent = false
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      if (now - last < 33 || document.hidden) return
      last = now
      const s = state.current!
      analyser.getFloatFrequencyData(s.data)
      let any = false
      for (let c = 0; c < columns; c += 1) {
        const { a, b, tilt } = ranges[c]
        let peak = -Infinity
        for (let i = a; i <= b && i < s.data.length; i += 1) if (s.data[i] > peak) peak = s.data[i]
        const value = Math.max(FLOOR, Math.min(6, peak + tilt))
        s.hold[c] = value > s.hold[c] ? value : Math.max(value, s.hold[c] - 1.6)
        if (s.hold[c] > FLOOR + 1) any = true
      }
      if (!any) { if (!silent) { fillEl.setAttribute('d', ''); lineEl.setAttribute('d', ''); silent = true } return }
      silent = false
      let d = ''
      for (let c = 0; c < columns; c += 1) {
        const y = height * (s.hold[c] / FLOOR)
        d += `${c ? 'L' : 'M'}${ranges[c].x.toFixed(1)} ${Math.max(0, y).toFixed(1)}`
      }
      lineEl.setAttribute('d', d)
      fillEl.setAttribute('d', `${d}L${width} ${height}L0 ${height}Z`)
    }
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame); fillEl.setAttribute('d', ''); lineEl.setAttribute('d', '') }
  }, [tap, width, height, fill, line])
}
