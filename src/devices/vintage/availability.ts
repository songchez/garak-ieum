import { loadGarakWasmModule, sharedGarakWasmModule } from '../../audio/rust/garakWasm'
import { hasInstrumentExports } from '../../audio/rust/vintageWasm'

/**
 * Browser availability of the vintage instruments: they run only from the Rust core compiled to
 * WebAssembly (public/wasm/garak-dsp.wasm, built by `pnpm build` / `pnpm rust:wasm`, the module the
 * 시김새 kernels use too). There is no TypeScript fallback, and `garak.rustDsp=0` does not switch them
 * off. Without the module (a checkout without Rust running `pnpm dev`, or no AudioWorklet)
 * the instruments stay in the library, editable and saved,
 * but greyed out and silent. The native engine reports its own capability instead.
 */
export type VintageWasmStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

let status: VintageWasmStatus = 'idle'
let module: WebAssembly.Module | null = null
let task: Promise<WebAssembly.Module | null> | null = null
const listeners = new Set<() => void>()
const baseUrl = () => (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

function publish(next: VintageWasmStatus): void {
  status = next
  for (const listener of [...listeners]) listener()
}

export const vintageWasmStatus = (): VintageWasmStatus => status
export const vintageWasmModule = (): WebAssembly.Module | null => module
export const vintageWorkletSupported = (): boolean => typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined'

export function subscribeVintageWasm(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Fetches + compiles the module once per page; resolves to null (never throws) when unavailable. */
export function loadVintageWasm(fetchImpl?: typeof fetch): Promise<WebAssembly.Module | null> {
  if (task) return task
  if (!vintageWorkletSupported()) { publish('unavailable'); return task = Promise.resolve(null) }
  publish('loading')
  // The same compiled module as the 시김새 kernels (one download); a test fetch loads its own copy.
  task = (fetchImpl ? loadGarakWasmModule(baseUrl(), fetchImpl) : sharedGarakWasmModule(baseUrl())).then(loaded => {
    module = loaded && hasInstrumentExports(loaded) ? loaded : null
    publish(module ? 'ready' : 'unavailable')
    return module
  }, () => { publish('unavailable'); return null })
  return task
}

export const VINTAGE_WEB_UNAVAILABLE = '이 브라우저에서 Rust 오디오 코어(WASM)를 불러오지 못해 빈티지 악기를 재생할 수 없습니다. 음색 편집과 프로젝트 저장은 사용할 수 있습니다.'
export const VINTAGE_NATIVE_UNAVAILABLE = '이 데스크톱 오디오 엔진은 Rust 코어 없이 빌드되어 빈티지 악기를 재생할 수 없습니다. 앱을 업데이트해 주세요. 음색 편집과 저장은 사용할 수 있습니다.'

/** Test hook: forget the cached load. */
export function resetVintageWasmForTests(): void {
  status = 'idle'; module = null; task = null
}
