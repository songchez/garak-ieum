import type { EffectDef, RealtimeEffectModule } from '../contracts.js'
import { clamp } from '../../audio/math.js'
import { parameterReader, setParameter, noTail, dbToGain } from './shared.js'
import { EQ_BAND_COUNT, EQ_OUTPUT_ID, IDENTITY_SECTION, MAX_SECTIONS, eqBandSections, eqParamDefs, readEqBands, type BiquadSection } from './eqModel.js'
import { createAnalysisTap, unbindDeviceAnalysis } from './analysis.js'
import { createWorkletGraph, prepareRustEffect, rustEffectsReady } from './sigimsae.js'

const definition: EffectDef = { name: 'Curve 8', short: 'EQ', label: '파라메트릭 EQ', params: eqParamDefs() }

/** Apply one biquad stage to a node, smoothing frequency/Q/gain like every built-in. */
export function applySection(node: BiquadFilterNode, section: BiquadSection, now: number, smooth: boolean, sampleRate: number): void {
  if (node.type !== section.type) node.type = section.type
  setParameter(node.frequency, clamp(section.freq, 10, sampleRate * 0.45), now, smooth)
  setParameter(node.Q, section.q, now, smooth)
  setParameter(node.gain, clamp(section.gain, -40, 40), now, smooth)
}

export const eqEffect: RealtimeEffectModule = {
  id: 'eq', kind: 'realtime-effect', stateVersion: 1, definition,
  prepare: prepareRustEffect,
  create(context, remember) {
    // Rust kernel (the desktop engine's, docs/RUST.md) whenever the module loaded; the Web Audio graph below is the fallback.
    if (rustEffectsReady(context)) return createWorkletGraph(context, remember, 'eq', { analysis: 'spectrum' })
    // Eight bands × four stages, always wired; unused stages are exact identities so band
    // switches and slope changes never rebuild the graph.
    const stages = Array.from({ length: EQ_BAND_COUNT * MAX_SECTIONS }, () => remember(context.createBiquadFilter()))
    const output = remember(context.createGain())
    for (let i = 1; i < stages.length; i += 1) stages[i - 1].connect(stages[i])
    stages[stages.length - 1].connect(output)
    const analysisTap = createAnalysisTap(context, output, remember)
    return {
      input: stages[0],
      output,
      analysisTap,
      dispose() { if (analysisTap) unbindDeviceAnalysis(analysisTap) },
      update(params, _bpm, now, smooth) {
        const p = parameterReader(definition.params, params)
        readEqBands(p).forEach((band, b) => {
          const sections = eqBandSections(band, context.sampleRate)
          for (let s = 0; s < MAX_SECTIONS; s += 1) applySection(stages[b * MAX_SECTIONS + s], sections[s] ?? IDENTITY_SECTION, now, smooth, context.sampleRate)
        })
        setParameter(output.gain, dbToGain(clamp(p(EQ_OUTPUT_ID), -24, 24)), now, smooth)
      },
    } as ReturnType<RealtimeEffectModule['create']>
  },
  tailSeconds: noTail,
}
