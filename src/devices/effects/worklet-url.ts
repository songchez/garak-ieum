/// <reference path="../guitar-rig/worklet-assets.d.ts" />
// Loaded only when preparing a browser audio context; the MCP catalog stays Node-safe.
import processorsUrl from './sigimsae.worklet.ts?worker&url'
export default processorsUrl
