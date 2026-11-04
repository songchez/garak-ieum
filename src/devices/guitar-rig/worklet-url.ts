/// <reference path="./worklet-assets.d.ts" />
// Loaded only when preparing a browser audio context; the MCP catalog stays Node-safe.
import processorsUrl from './processors.worklet.ts?worker&url'
export default processorsUrl
