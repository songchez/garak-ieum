/// <reference path="../../devices/guitar-rig/worklet-assets.d.ts" />
// Loaded only when the Rust engine flag is on and an audio context is prepared.
import processorUrl from './engine.worklet.ts?worker&url'
export default processorUrl
