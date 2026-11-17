/// <reference path="../worklet-assets.d.ts" />
// Loaded once per audio context, when the engine worklet node is created.
import processorUrl from './engine.worklet.ts?worker&url'
export default processorUrl
