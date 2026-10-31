import { Icon } from './Icon'
import { shortcutLabel } from '../core/input'
import type { ZoomCommand } from '../core/zoom'

const LABELS: Record<ZoomCommand, string> = { zoomOut: '가로 축소', zoomIn: '가로 확대', zoomOutV: '세로 축소', zoomInV: '세로 확대', zoomToFit: '맞춰 보기' }

/**
 * Per-area zoom buttons. A pointer press keeps (or moves) key focus on the owning
 * area instead of the button, so the zoom keys keep targeting the same area.
 */
export function ZoomControls({ onZoom, area, axes = 'xy', labels, focusTarget }: { onZoom: (command: ZoomCommand) => void; area: string; axes?: 'xy' | 'x' | 'one'; labels?: Partial<Record<ZoomCommand, string>>; focusTarget?: () => HTMLElement | null }) {
  const text = { ...LABELS, ...labels }
  const keepFocus = (e: React.MouseEvent<HTMLElement>) => { if (e.button !== 0) return; e.preventDefault(); (focusTarget?.() ?? e.currentTarget.closest<HTMLElement>('[data-keyboard-scope]'))?.focus({ preventScroll: true }) }
  const button = (command: ZoomCommand, icon: string) => <button type="button" onMouseDown={keepFocus} onClick={() => onZoom(command)} title={`${area} ${text[command]} · ${shortcutLabel(command)}`} aria-label={`${area} ${text[command]}`}><Icon name={icon} size={12}/></button>
  return <div className="zoom-group" role="group" aria-label={`${area} 확대/축소`}>
    {axes === 'one' ? <>{button('zoomOut', 'minus')}<span className="zoom-axis" aria-hidden="true"><Icon name="search" size={11}/></span>{button('zoomIn', 'plus')}</>
      : <><span className="zoom-axis" title="가로" aria-hidden="true"><Icon name="arrowsH" size={11}/></span>{button('zoomOut', 'minus')}{button('zoomIn', 'plus')}
        {axes === 'xy' && <><span className="zoom-axis zoom-axis--sep" title="세로" aria-hidden="true"><Icon name="arrowsV" size={11}/></span>{button('zoomOutV', 'minus')}{button('zoomInV', 'plus')}</>}</>}
    {button('zoomToFit', 'fit')}
  </div>
}
