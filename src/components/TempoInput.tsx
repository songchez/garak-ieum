import { useEffect, useRef, useState } from 'react'
import { editTempo, isTempoText, MAX_BPM, MIN_BPM, type TempoAction, type TempoDraft } from './tempoEditing'

interface Props {
  value: number
  onCommit(value: number): void
  disabled?: boolean
}

/** A text draft permits clearing/retyping without changing the engine to an invalid BPM. */
export function TempoInput({ value, onCommit, disabled = false }: Props) {
  const [draft, setDraft] = useState<TempoDraft | null>(null)
  const currentDraft = useRef<TempoDraft | null>(null)
  function apply(action: TempoAction) {
    const next = editTempo(currentDraft.current, action, value)
    currentDraft.current = next.draft
    setDraft(next.draft)
    if (next.commit !== undefined && !disabled) onCommit(next.commit)
  }
  useEffect(() => {
    const next = editTempo(currentDraft.current, { type: disabled ? 'cancel' : 'sync' }, value)
    currentDraft.current = next.draft
    setDraft(next.draft)
  }, [value, disabled])

  return <input
    type="text" inputMode="numeric" pattern="[0-9]*" role="spinbutton"
    aria-label="템포 BPM" aria-valuemin={MIN_BPM} aria-valuemax={MAX_BPM} aria-valuenow={value}
    title={`템포 · ${MIN_BPM}–${MAX_BPM} BPM · Enter로 적용, Esc로 취소`}
    autoComplete="off" spellCheck={false} disabled={disabled}
    value={draft?.text ?? String(value)}
    onFocus={() => apply({ type: 'focus' })}
    onChange={event => apply({ type: 'input', text: event.currentTarget.value })}
    onBlur={() => apply({ type: disabled ? 'cancel' : 'commit' })}
    onPaste={event => { if (!isTempoText(event.clipboardData.getData('text'))) event.preventDefault() }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.key === 'Process' || event.key === 'Dead') return
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        apply({ type: event.key === 'Enter' ? 'commit' : 'cancel' })
        event.currentTarget.blur()
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); event.stopPropagation()
          apply({ type: 'step', delta: event.key === 'ArrowUp' ? 1 : -1 })
        } else if (event.key.length === 1 && !isTempoText(event.key)) {
          event.preventDefault(); event.stopPropagation()
        }
      }
    }}
  />
}
