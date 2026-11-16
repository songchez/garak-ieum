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
