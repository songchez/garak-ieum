import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { parameterReader, noTail } from './shared.js'
import { FILTER_SLOPES, IDENTITY_SECTION, MAX_SECTIONS, filterSections } from './eqModel.js'
import { applySection } from './eq.js'
import { createAnalysisTap, unbindDeviceAnalysis } from './analysis.js'
import { createWorkletGraph, prepareRustEffect, rustEffectsReady } from './sigimsae.js'

const definition: EffectDef = {
  name: 'Sweep', short: '필터', label: '필터',
  params: [
    { id: 'cutoff', label: '컷오프', min: 20, max: 20000, default: 1200, unit: 'hz', scale: 'log' },
    { id: 'resonance', label: '레조넌스', min: 0.1, max: 18, default: 0.7, unit: 'q', scale: 'log' },
    { id: 'mode', label: '모드', min: 0, max: 2, default: 0, unit: 'q', options: [{ value: 0, label: '로우패스' }, { value: 1, label: '하이패스' }, { value: 2, label: '밴드패스' }] },
    // Appended after the original three; 12 dB/oct is the original single-stage filter.
    { id: 'slope', label: '기울기', min: 0, max: 2, default: 0, unit: 'q', options: FILTER_SLOPES.map((slope, value) => ({ value, label: `${slope} dB/oct` })) },
  ],
}

export const filterEffect: RealtimeEffectModule = {
  id: 'filter', kind: 'realtime-effect', stateVersion: 1, definition,
  prepare: prepareRustEffect,
  create(context, remember) {
    // Rust kernel (the desktop engine's, docs/RUST.md) whenever the module loaded; the Web Audio graph below is the fallback.
    if (rustEffectsReady(context)) return createWorkletGraph(context, remember, 'filter', { analysis: 'spectrum' })
    const stages = Array.from({ length: MAX_SECTIONS }, () => remember(context.createBiquadFilter()))
    for (let i = 1; i < stages.length; i += 1) stages[i - 1].connect(stages[i])
    const output = stages[stages.length - 1]
    const analysisTap = createAnalysisTap(context, output, remember)
    return {
      input: stages[0],
      output,
      analysisTap,
      dispose() { if (analysisTap) unbindDeviceAnalysis(analysisTap) },
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        const sections = filterSections(p('mode'), p('cutoff'), p('resonance'), p('slope'), context.sampleRate)
        stages.forEach((node, i) => applySection(node, sections[i] ?? IDENTITY_SECTION, now, smooth, context.sampleRate))
      },
    } as ReturnType<RealtimeEffectModule['create']>
  },
  tailSeconds: noTail,
}
