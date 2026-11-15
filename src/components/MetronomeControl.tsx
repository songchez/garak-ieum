import { useRef, useState, useSyncExternalStore } from 'react'
import { getMetronomePrefs, METRONOME_SOUNDS, subscribeMetronomePrefs, updateMetronomePrefs, type CountInBars, type MetronomeSoundId } from '../core/metronome'
import type { TimeSignature } from '../core/types'
import { isCompoundMeter } from '../core/metronome'
import { metronomeStrokes } from '../audio/metronomeSounds'
import { Popover } from './HeaderConfigPopover'
import { Icon } from './Icon'
import './MetronomeControl.css'

let previewContext: AudioContext | null = null
/** A one-bar audition on a small private context; it never touches the project engine or its device. */
function previewSound(sound: MetronomeSoundId, accent: boolean, volume: number, signature: TimeSignature): void {
  try {
    previewContext ??= new AudioContext({ latencyHint: 'interactive' })
    const context = previewContext
    void context.resume()
    const strokes = metronomeStrokes(sound, accent, context.sampleRate)
    const compound = isCompoundMeter(signature)
    const pattern = compound ? [0, 2, 2, 1, 2, 2] : [0, 2, 2, 2]
    const gain = context.createGain()
    gain.gain.value = volume
    gain.connect(context.destination)
    const start = context.currentTime + 0.04
    pattern.forEach((level, index) => {
      const buffer = context.createBuffer(1, strokes[level].length, context.sampleRate)
      buffer.copyToChannel(strokes[level], 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      source.start(start + index * (compound ? 0.22 : 0.42))
    })
  } catch { /* Audition is best effort. */ }
}

interface Props { timeSignature: TimeSignature; shortcut: string }

/** Header metronome: K toggles; the chevron opens sound, volume, accent, count-in and record-only options (app preferences). */
export function MetronomeControl({ timeSignature, shortcut }: Props) {
  const prefs = useSyncExternalStore(subscribeMetronomePrefs, getMetronomePrefs, getMetronomePrefs)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const group = useRef<HTMLDivElement>(null)
  // The popover closes on any outside press, including the chevron's own; do not reopen it from that press.
  const closedAt = useRef(0)
  const sound = METRONOME_SOUNDS.find(item => item.id === prefs.sound) ?? METRONOME_SOUNDS[0]
  const compound = isCompoundMeter(timeSignature)
  const title = `메트로놈 ${prefs.enabled ? '끄기' : '켜기'} · ${shortcut}${prefs.enabled ? ` (${sound.label}${prefs.recordOnly ? ', 녹음 중에만' : ''})` : ''}`
  const open = () => {
    if (performance.now() - closedAt.current < 250) return
    const rect = group.current?.getBoundingClientRect()
    setAnchor(anchor ? null : { x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 6 })
  }
  return <div className="metronome-control" ref={group} role="group" aria-label="메트로놈">
    <button className={`icon-button metronome-toggle${prefs.enabled ? ' active' : ''}`} aria-pressed={prefs.enabled} aria-label="메트로놈" title={title}
      onClick={() => updateMetronomePrefs({ enabled: !prefs.enabled })}><Icon name="metronome" size={17}/>{prefs.countInBars > 0 && <i className="metronome-count-badge" aria-hidden="true">{prefs.countInBars}</i>}</button>
    <button className={`metronome-more${anchor ? ' open' : ''}`} aria-label="메트로놈 설정" aria-expanded={!!anchor} aria-haspopup="dialog" title="메트로놈 소리·카운트인 설정" onClick={open}><Icon name="chevron" size={11}/></button>
    {anchor && <Popover x={anchor.x} y={anchor.y} title="메트로놈" className="metronome-popover" onClose={() => { closedAt.current = performance.now(); setAnchor(null) }}>
      <label className="metronome-row metronome-switch"><input type="checkbox" checked={prefs.enabled} onChange={event => updateMetronomePrefs({ enabled: event.target.checked })}/><span>메트로놈 켜기</span><kbd>{shortcut}</kbd></label>
      {(['classic', 'gugak'] as const).map(family => <fieldset key={family} className="metronome-sounds">
        <legend>{family === 'classic' ? '기본 소리' : '국악 타악기'}</legend>
        <div className="metronome-sound-grid" role="radiogroup" aria-label={family === 'classic' ? '기본 소리' : '국악 타악기'}>
          {METRONOME_SOUNDS.filter(item => item.family === family).map(item => <button key={item.id} type="button" role="radio" aria-checked={item.id === prefs.sound}
            className={`metronome-sound${item.id === prefs.sound ? ' selected' : ''}`} title={`${item.label} · ${item.strokes.join(' / ')}`}
            onClick={() => { updateMetronomePrefs({ sound: item.id }); previewSound(item.id, prefs.accent, prefs.volume, timeSignature) }}>{item.label}</button>)}
        </div>
      </fieldset>)}
      <p className="metronome-strokes" aria-live="polite">{prefs.accent
        ? <>첫 박 <b>{sound.strokes[0]}</b>{compound && <> · 묶음 첫 박 <b>{sound.strokes[1]}</b></>} · 나머지 <b>{sound.strokes[2]}</b></>
        : <>모든 박 <b>{sound.strokes[2]}</b></>}</p>
      <div className="metronome-row metronome-volume">
        <span>음량</span>
        <input type="range" min="0" max="1" step="0.01" value={prefs.volume} aria-label="메트로놈 음량" onChange={event => updateMetronomePrefs({ volume: Number(event.target.value) })}/>
        <output>{Math.round(prefs.volume * 100)}%</output>
        <button type="button" className="icon-button small" aria-label="미리 듣기" title="한 마디 미리 듣기" onClick={() => previewSound(prefs.sound, prefs.accent, prefs.volume, timeSignature)}><Icon name="play" size={12}/></button>
      </div>
      <label className="metronome-row"><input type="checkbox" checked={prefs.accent} onChange={event => updateMetronomePrefs({ accent: event.target.checked })}/><span>첫 박 강세{compound ? ' (겹박자는 점4분음표 묶음도)' : ''}</span></label>
      <label className="metronome-row"><input type="checkbox" checked={prefs.recordOnly} onChange={event => updateMetronomePrefs({ recordOnly: event.target.checked })}/><span>녹음할 때만 소리 내기</span></label>
      <div className="metronome-row metronome-countin" role="radiogroup" aria-label="녹음 카운트인">
        <span title="⇧K로 켜기/끄기">녹음 카운트인</span>
        {([0, 1, 2] as CountInBars[]).map(bars => <button key={bars} type="button" role="radio" aria-checked={prefs.countInBars === bars} className={prefs.countInBars === bars ? 'selected' : ''} onClick={() => updateMetronomePrefs({ countInBars: bars })}>{bars ? `${bars}마디` : '끔'}</button>)}
      </div>
      <p className="popover-hint">클릭은 모니터 출력에만 나오며 녹음·내보내기에는 들어가지 않습니다.</p>
    </Popover>}
  </div>
}
