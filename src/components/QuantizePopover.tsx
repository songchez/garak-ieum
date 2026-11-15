import { useEffect, useRef } from 'react'
import { DEFAULT_QUANTIZE_OPTIONS, type QuantizeOptions } from '../core/quantize'

export type PianoQuantizeSettings = Required<QuantizeOptions> & { /** Follow the piano roll's mouse snap (1/16 when free). */ followSnap: boolean }
export const DEFAULT_PIANO_QUANTIZE: PianoQuantizeSettings = { ...DEFAULT_QUANTIZE_OPTIONS, followSnap: true }

const KEY = 'garak.pianoQuantize'
export function loadPianoQuantize(): PianoQuantizeSettings {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<PianoQuantizeSettings> | null
    if (!value || typeof value !== 'object') return DEFAULT_PIANO_QUANTIZE
    const num = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
    return {
      grid: num(value.grid, DEFAULT_PIANO_QUANTIZE.grid, 1 / 64, 4), strength: num(value.strength, 100, 0, 100), swing: num(value.swing, 50, 0, 100),
      starts: value.starts !== false, ends: value.ends === true, followSnap: value.followSnap !== false,
    }
  } catch { return DEFAULT_PIANO_QUANTIZE }
}
export function savePianoQuantize(settings: PianoQuantizeSettings): void { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)) } catch { /* session only */ } }

const GRIDS: [string, number][] = [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/64', 0.0625], ['1/4T', 2 / 3], ['1/8T', 1 / 3], ['1/16T', 1 / 6]]

/** Piano roll Q options (Logic Time Quantize / Ableton Quantize Settings). Applying uses and remembers them; Q repeats them. */
export function QuantizePopover({ settings, onChange, onApply, onClose, hasSelection }: { settings: PianoQuantizeSettings; onChange(next: PianoQuantizeSettings): void; onApply(): void; onClose(): void; hasSelection: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node) && !(event.target as Element)?.closest?.('.piano-quantize-toggle')) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [onClose])
  const set = (patch: Partial<PianoQuantizeSettings>) => onChange({ ...settings, ...patch })
  return <div className="piano-quantize-popover" ref={root} role="dialog" aria-label="퀀타이즈 설정">
    <label><span>격자</span><select aria-label="퀀타이즈 격자" value={settings.followSnap ? 'snap' : String(settings.grid)} onChange={event => event.target.value === 'snap' ? set({ followSnap: true }) : set({ followSnap: false, grid: Number(event.target.value) })}>
      <option value="snap">스냅 따라가기</option>
      {GRIDS.map(([label, value]) => <option key={label} value={String(value)}>{label}</option>)}
    </select></label>
    <label><span>강도</span><input type="range" min={0} max={100} step={1} value={settings.strength} aria-label="퀀타이즈 강도" onChange={event => set({ strength: Number(event.target.value) })} /><output>{settings.strength}%</output></label>
    <label><span>스윙</span><input type="range" min={0} max={100} step={1} value={settings.swing} aria-label="퀀타이즈 스윙" onChange={event => set({ swing: Number(event.target.value) })} /><output>{settings.swing}%</output></label>
    <label className="piano-quantize-check"><input type="checkbox" checked={settings.starts} onChange={event => set({ starts: event.target.checked })} />음 시작</label>
    <label className="piano-quantize-check"><input type="checkbox" checked={settings.ends} onChange={event => set({ ends: event.target.checked })} />음 끝</label>
    <div className="piano-quantize-actions"><button type="button" className="primary" disabled={!settings.starts && !settings.ends} onClick={onApply}>{hasSelection ? '선택 음표 퀀타이즈' : '모두 퀀타이즈'}</button></div>
    <small>Q: 이 설정으로 퀀타이즈 · ⇧Q: 음 끝도 함께</small>
  </div>
}
