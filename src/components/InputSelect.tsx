import type { InputChoice, TrackInput } from '../core/types'
import { DEFAULT_INPUT_LABEL, inputFromChoice, inputKey, inputText } from '../core/trackInputs'

/** Track input chooser: the engine default plus the device's mono/stereo inputs. A saved input the device
 * does not offer stays listed (marked missing) so opening the menu never silently changes it. */
export function InputSelect({ input, choices, onChange, className = 'insp-select', ariaLabel, disabled }: {
  input: TrackInput | undefined; choices: readonly InputChoice[]; onChange(input: TrackInput | null): void
  className?: string; ariaLabel: string; disabled?: boolean
}) {
  const key = inputKey(input)
  const listed = !input || choices.some(choice => inputKey(choice) === key)
  const mono = choices.filter(choice => choice.channels.length === 1), stereo = choices.filter(choice => choice.channels.length === 2)
  const option = (choice: InputChoice) => <option key={inputKey(choice)} value={inputKey(choice)}>{choice.label}</option>
  return <select className={className} aria-label={ariaLabel} value={key} disabled={disabled}
    title={choices.length ? inputText(input) : `${inputText(input)} · 장치가 입력 목록을 알리지 않아 기본 입력만 고를 수 있습니다`}
    onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
    onChange={e => { const choice = choices.find(item => inputKey(item) === e.target.value); if (e.target.value !== key) onChange(choice ? inputFromChoice(choice) : null) }}>
    <option value="">{DEFAULT_INPUT_LABEL}</option>
    {!listed && <option value={key}>{choices.length ? `${inputText(input)} (연결 안 됨)` : inputText(input)}</option>}
    {mono.length > 0 && <optgroup label="모노">{mono.map(option)}</optgroup>}
    {stereo.length > 0 && <optgroup label="스테레오">{stereo.map(option)}</optgroup>}
  </select>
}
