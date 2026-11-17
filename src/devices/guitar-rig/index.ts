import type { EffectModule } from '../contracts.js'
import { guitarRigDefinition, guitarRigOrder, parseRigSlot, rigParam, GUITAR_RIG_PARAMS } from './definition.js'

export * from './definition.js'
export { detectPitch, guitarTunerTap, tunerReading, TUNER_A4, type TunerReading } from './tuner.js'

/** The rig's plate reverb: the Decay knob crossfades a 1.7 s and a 4.2 s impulse (garak-dsp `RigReverb`). */
const REVERB_SHORT_SECONDS = 1.7
const REVERB_LONG_SECONDS = 4.2
const reverbTailSeconds = (decay: number) => (decay > 0.001 ? REVERB_LONG_SECONDS : REVERB_SHORT_SECONDS) + 0.25

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function reader(params: Record<string, number>): (id: string) => number {
  return id => {
    const def = GUITAR_RIG_PARAMS.find(p => p.id === id)!
    const value = params[id]
    return clamp(Number.isFinite(value) ? value : def.default, def.min, def.max)
  }
}

/** The guitar rig insert. Its DSP is the engine's (rust/garak-dsp `GuitarRig`), on the web in garak-engine.wasm. */
export const guitarRigEffect: EffectModule = {
  id: 'guitar-rig', stateVersion: 1, definition: guitarRigDefinition,
  tailSeconds(params) {
    const p = reader(params)
    let tail = 0
    for (const key of guitarRigOrder(params)) {
      const { id, instance } = parseRigSlot(key), q = (base: string) => p(rigParam(base, instance))
      if (id === 'chorus' && q('chorusEnabled') >= 0.5 && q('chorusMix') > 0) tail += 0.04
      if (id === 'reverb' && q('reverbEnabled') >= 0.5 && q('reverbMix') > 0) tail += reverbTailSeconds(q('reverbDecay'))
      if (id === 'delay' && q('delayEnabled') >= 0.5 && q('delayMix') > 0) {
        const feedback = q('delayFeedback')
        // The native rig's estimate (garak-dsp RigDelay): exports run as long as on desktop.
        const repeats = feedback > 0.01 ? Math.ceil(Math.log(0.001) / Math.log(feedback)) : 1
        tail += Math.min(30, q('delayTime') / 1000 * (repeats + 1) + 0.85)
      }
    }
    return tail
  },
}
