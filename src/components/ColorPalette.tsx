import { useEffect, useRef, useState } from 'react'
import { PALETTE_COLUMNS, PALETTE_ROWS, TRACK_PALETTE, paletteIndex } from '../core/colors'
import { shortcutPlatform } from '../core/input'
import { Popover } from './HeaderConfigPopover'
import './ColorPalette.css'

const MOD = shortcutPlatform() === 'mac' ? '⌘' : 'Ctrl+'
const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey

/** 96 swatches (4 rows × 24 hues). Click = selected tracks and their regions, ⌘/Ctrl-click = tracks only. */
export function ColorPalette({ x, y, value, onPick, onClose }: { x: number; y: number; value: string; onPick(hex: string, trackOnly: boolean): void; onClose(): void }) {
  const current = paletteIndex(value)
  const [cursor, setCursor] = useState(current >= 0 ? current : 0)
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => { grid.current?.focus({ preventScroll: true }) }, [])

  function keyDown(e: React.KeyboardEvent) {
    const row = Math.floor(cursor / PALETTE_COLUMNS), col = cursor % PALETTE_COLUMNS
    const go = (r: number, c: number) => setCursor(((r + PALETTE_ROWS) % PALETTE_ROWS) * PALETTE_COLUMNS + (c + PALETTE_COLUMNS) % PALETTE_COLUMNS)
    switch (e.key) {
      case 'ArrowLeft': go(row, col - 1); break
      case 'ArrowRight': go(row, col + 1); break
      case 'ArrowUp': go(row - 1, col); break
      case 'ArrowDown': go(row + 1, col); break
      case 'Home': go(row, 0); break
      case 'End': go(row, PALETTE_COLUMNS - 1); break
      case 'Enter': case ' ': onPick(TRACK_PALETTE[cursor], isMod(e)); break
      default: return
    }
    e.preventDefault()
  }

  return <Popover x={x} y={y} title="트랙 색상" className="color-palette" onClose={onClose}>
    <div ref={grid} className="color-palette-grid" role="listbox" aria-label="트랙 색상" aria-activedescendant={`palette-${cursor}`} tabIndex={0} onKeyDown={keyDown} style={{ gridTemplateColumns: `repeat(${PALETTE_COLUMNS}, 1fr)` }}>
      {TRACK_PALETTE.map((hex, i) => <button key={hex} id={`palette-${i}`} type="button" role="option" tabIndex={-1} aria-selected={i === current} className={`color-swatch${i === current ? ' current' : ''}${i === cursor ? ' cursor' : ''}`} style={{ background: hex }} title={`${hex} · ${MOD}클릭: 트랙만`}
        onPointerEnter={() => setCursor(i)} onClick={e => onPick(hex, isMod(e))}/>)}
    </div>
    <div className="popover-hint">클릭: 선택한 트랙과 리전 · {MOD}클릭: 트랙만</div>
  </Popover>
}
