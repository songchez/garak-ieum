/**
 * Opt-in switch for the Rust/WASM DSP core during the migration (docs/RUST.md). Off by default:
 * the TypeScript worklet kernels and the C++ native engine stay the default paths, and the app
 * works whether or not `public/wasm/garak-dsp.wasm` was built.
 *
 * Enable with `VITE_GARAK_RUST_DSP=1 pnpm dev`, or in the browser console:
 *   localStorage.setItem('garak.rustDsp', '1')
 */
export const RUST_DSP_STORAGE_KEY = 'garak.rustDsp'

export function rustDspRequested(): boolean {
  if (import.meta.env?.VITE_GARAK_RUST_DSP === '1') return true
  try { return globalThis.localStorage?.getItem(RUST_DSP_STORAGE_KEY) === '1' } catch { return false }
}
