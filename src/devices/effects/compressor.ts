import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, dbToGain, noTail } from './shared.js'
import { analyserPeak, type DynamicsMeterSource } from './dynamicsMeter.js'
import { createWorkletGraph, prepareRustEffect, rustEffectsReady } from './sigimsae.js'

const definition: EffectDef = {
  name: 'Glue 76', short: '컴프', label: '컴프레서',
  params: [
    { id: 'threshold', label: '스레숄드', min: -60, max: 0, default: -18, unit: 'db' },
    { id: 'ratio', label: '비율', min: 1, max: 20, default: 4, unit: 'ratio', scale: 'log' },
    { id: 'attack', label: '어택', min: 0.1, max: 100, default: 10, unit: 'ms', scale: 'log' },
    { id: 'release', label: '릴리즈', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
    { id: 'makeup', label: '메이크업', min: 0, max: 24, default: 0, unit: 'db' },
  ],
}

export const compressorEffect: RealtimeEffectModule = {
  id: 'compressor', kind: 'realtime-effect', stateVersion: 1, definition,
  prepare: prepareRustEffect,
  create(context, remember) {
    // Rust kernel (the desktop engine's, docs/RUST.md) whenever the module loaded; the Web Audio graph below is the fallback.
    // The Rust compressor (dsp.cpp) reports its own detector level and gain reduction to the view.
    if (rustEffectsReady(context)) return createWorkletGraph(context, remember, 'compressor')
    const compressor = remember(context.createDynamicsCompressor())
    const makeup = remember(context.createGain())
    compressor.knee.value = 6
    compressor.connect(makeup)
    // Realtime only: an input analyser for the view's live level (DynamicsCompressorNode reports reduction itself).
    const realtime = !('startRendering' in context) && typeof context.createAnalyser === 'function'
    const entry = realtime ? remember(context.createGain()) : null
    let dynamicsMeter: DynamicsMeterSource | undefined
    if (entry) {
      const analyser = remember(context.createAnalyser())
      analyser.fftSize = 2048
      entry.connect(compressor); entry.connect(analyser)
      const scratch = new Float32Array(analyser.fftSize)
      dynamicsMeter = { read: () => ({ input: analyserPeak(analyser, scratch), gain: Math.min(1, dbToGain(Math.min(0, compressor.reduction || 0))) }) }
    }
    return {
      input: entry ?? compressor,
      output: makeup,
      dynamicsMeter,
      dispose() { if (dynamicsMeter) dynamicsMeter.disposed = true },
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        setParameter(compressor.threshold, clamp(p('threshold'), -100, 0), now, smooth)
        setParameter(compressor.ratio, clamp(p('ratio'), 1, 20), now, smooth)
        setParameter(compressor.attack, clamp(p('attack') / 1000, 0, 1), now, smooth)
        setParameter(compressor.release, clamp(p('release') / 1000, 0, 1), now, smooth)
        setParameter(makeup.gain, dbToGain(clamp(p('makeup'), -60, 40)), now, smooth)
      },
    }
  },
  tailSeconds: noTail,
}
