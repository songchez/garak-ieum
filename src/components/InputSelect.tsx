import type { InputChoice, Track, TrackInput, TrackInputRoute, TrackInputTap } from '../core/types'
import { DEFAULT_INPUT_LABEL, inputFromChoice, inputKey, inputText } from '../core/trackInputs'
import { DEFAULT_TAP, MASTER_ROUTE_LABEL, TAP_LABELS, TAP_ORDER, routeChoices, routeFromKey, routeKey, routeText } from '../core/trackRouting'

/** Track input chooser: the engine default plus the device's mono/stereo inputs. A saved input the device
 * does not offer stays listed (marked missing) so opening the menu never silently changes it.
 * With `routing`, other tracks and the master (resampling) are listed too (docs/TRACK_INPUT_ROUTING.md). */
export function InputSelect({ input, choices, onChange, className = 'insp-select', ariaLabel, disabled, routing }: {
  input: TrackInput | undefined; choices: readonly InputChoice[]; onChange(input: TrackInput | null): void
  className?: string; ariaLabel: string; disabled?: boolean
  /** Internal routes: `onChange(route, input)` replaces the route; a physical choice passes route null with its input. */
  routing?: { track: Track; tracks: readonly Track[]; onChange(route: TrackInputRoute | null, input?: TrackInput | null): void }
}) {
  const route = routing?.track.kind === 'audio' ? routing.track.inputRoute : undefined
  const key = route ? `route:${routeKey(route)}` : inputKey(input)
  const listed = !input || choices.some(choice => inputKey(choice) === inputKey(input))
  const mono = choices.filter(choice => choice.channels.length === 1), stereo = choices.filter(choice => choice.channels.length === 2)
  const option = (choice: InputChoice) => <option key={inputKey(choice)} value={inputKey(choice)}>{choice.label}</option>
  const tracks = routing ? routeChoices({ tracks: routing.tracks }, routing.track.id) : []
  const currentText = routing && route ? routeText(routing.tracks, routing.track) : null
  const tap: TrackInputTap = route?.kind === 'track' ? route.tap : DEFAULT_TAP
  const title = currentText ?? (choices.length ? inputText(input) : `${inputText(input)} · 장치가 입력 목록을 알리지 않아 기본 입력만 고를 수 있습니다`)
  function change(value: string) {
    if (value === key) return
    if (routing && value.startsWith('route:')) {
      const next = routeFromKey(value.slice(6), tap)
      if (next) routing.onChange(next)
      return
    }
    const choice = choices.find(item => inputKey(item) === value)
    const physical = choice ? inputFromChoice(choice) : value === inputKey(input) && input ? input : null
    if (routing && route) routing.onChange(null, physical)
    else onChange(physical)
  }
  return <select className={className} aria-label={ariaLabel} value={key} disabled={disabled} title={title}
    onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onChange={e => change(e.target.value)}>
    <option value="">{DEFAULT_INPUT_LABEL}</option>
    {input && !listed && <option value={inputKey(input)}>{choices.length ? `${inputText(input)} (연결 안 됨)` : inputText(input)}</option>}
    {mono.length > 0 && <optgroup label="모노">{mono.map(option)}</optgroup>}
    {stereo.length > 0 && <optgroup label="스테레오">{stereo.map(option)}</optgroup>}
    {routing && <optgroup label="트랙 (내부 녹음)">
      {tracks.map(choice => {
        const value = `route:track:${choice.trackId}`
        const selected = value === key
        return <option key={value} value={value} disabled={!!choice.problem && !selected} title={choice.problem ?? undefined}>
          {selected && currentText ? currentText : `${choice.name}${choice.kind === 'instrument' ? ' (악기)' : ''}${choice.problem ? ' — 되먹임 루프' : ''}`}
        </option>
      })}
      <option value="route:master">{route?.kind === 'master' && currentText ? currentText : MASTER_ROUTE_LABEL}</option>
      {route?.kind === 'none' && <option value="route:none">{currentText}</option>}
    </optgroup>}
  </select>
}

/** Where a track route listens on its source: 시김새 전 / 시김새 후 / 페이더 후. */
export function TapSelect({ value, onChange, className = 'insp-select', disabled }: { value: TrackInputTap; onChange(tap: TrackInputTap): void; className?: string; disabled?: boolean }) {
  return <select className={className} aria-label="입력 탭 위치" value={value} disabled={disabled} title="원본 트랙의 어느 지점 신호를 받을지 고릅니다"
    onPointerDown={e => e.stopPropagation()} onChange={e => onChange(e.target.value as TrackInputTap)}>
    {TAP_ORDER.map(tap => <option key={tap} value={tap}>{TAP_LABELS[tap]}</option>)}
  </select>
}
