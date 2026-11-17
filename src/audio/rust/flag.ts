/**
 * Switch for the Rust/WASM DSP core on the web (docs/RUST.md). On by default since stage 3: every
 * built-in effect except the guitar rig runs the same Rust kernels as the desktop engine. When the
 * module is missing (a checkout without Rust running `pnpm dev`) or fails to load, the app falls
 * back to the TypeScript kernels and built-in Web Audio nodes on its own.
 *
 * Opt out (listening comparisons, bug hunts) with `VITE_GARAK_RUST_DSP=0 pnpm dev` / `pnpm build`,
 * or in the browser console, then reload:
 *   localStorage.setItem('garak.rustDsp', '0')
 */
export const RUST_DSP_STORAGE_KEY = 'garak.rustDsp'

export function rustDspRequested(): boolean {
  // Typed loosely so Node-only builds (the MCP server reaches this through the effect registry)
  // compile without Vite's client types; Vite still substitutes `import.meta.env` in the app.
  if ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GARAK_RUST_DSP === '0') return false
  try { return globalThis.localStorage?.getItem(RUST_DSP_STORAGE_KEY) !== '0' } catch { return true }
}

/**
 * Switch for the unified Rust render engine on the web (docs/RUST_ENGINE.md 5, stage 5): the whole
 * project renders in one AudioWorklet running garak-engine.wasm (src/audio/rust/RustWebAudioEngine.ts)
 * instead of the Web Audio graph. Off by default while the engine is completed (instruments, meters).
 * Projects the engine does not accept yet (it says why) keep playing and exporting on the Web Audio
 * engine, with a console note; when the engine starts accepting them, they switch on their own.
 *
 * Opt in with `VITE_GARAK_RUST_ENGINE=1 pnpm dev` / `pnpm build`, or in the browser console, then reload:
 *   localStorage.setItem('garak.rustEngine', '1')
 * `localStorage.setItem('garak.rustEngine', '0')` opts a page out of a build that turned it on.
 */
export const RUST_ENGINE_STORAGE_KEY = 'garak.rustEngine'

export function rustEngineRequested(): boolean {
  let stored: string | null | undefined
  try { stored = globalThis.localStorage?.getItem(RUST_ENGINE_STORAGE_KEY) } catch { stored = null }
  if (stored === '1' || stored === '0') return stored === '1'
  return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GARAK_RUST_ENGINE === '1'
}
