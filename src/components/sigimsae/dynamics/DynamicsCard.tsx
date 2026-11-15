import { useState } from 'react'
import { effectDeviceName } from '../../../core/sigimsaeDevices'
import { EFFECT_DEFS } from '../../../core/devices'
import { Knob } from '../../Knob'
import { Icon } from '../../Icon'
import type { DeviceViewProps } from '../types'
import { useDynamicsFeed } from './feed'
import { GrMeter, TransferGraph, VuNeedle, type DynamicsKind } from './graphs'
import { DynamicsEditor, summary } from './DynamicsEditor'
import './dynamics.css'

/** Parameters drawn on the graph; the rest get knobs on the card. */
const ON_GRAPH: Record<DynamicsKind, readonly string[]> = { compressor: ['threshold', 'ratio'], limiter: ['ceiling', 'gain'], gate: ['threshold'] }

/** "76"-flavoured compressors (the default Glue 76 and 76 Punch) get a VU needle. */
export const hasVuNeedle = (kind: DynamicsKind, name: string) => kind === 'compressor' && /76/.test(name)

/**
 * Rack card body for the compressor, limiter and gate: a transfer curve you drag (threshold,
 * ratio / ceiling, gain), a live input dot, a GR meter, and knobs for the remaining times. The
 * expand button or a double-click on the curve opens the large editor.
 */
export function DynamicsCard(props: DeviceViewProps & { kind: DynamicsKind }) {
  const { kind, device, defs, value, onParam, onParams, engine, color } = props
  const feed = useDynamicsFeed(engine, device.id)
  const [open, setOpen] = useState(false)
  const name = effectDeviceName(device)
  const label = EFFECT_DEFS[device.type].label ?? ''
  const access = { defs, value, onParam, onParams }
  const vu = hasVuNeedle(kind, name)
  const knobs = defs.filter(def => !ON_GRAPH[kind].includes(def.id))
  return (
    <div className="dyn-card" data-kind={kind} style={color ? { '--dyn-track': color } as React.CSSProperties : undefined}>
      <div className="dyn-card-top">
        <div className="dyn-card-graph" onDoubleClick={event => { if (!(event.target as Element).closest('.dyn-handle')) setOpen(true) }}>
          <TransferGraph {...access} kind={kind} feed={feed} size={116} compact name={name}/>
          <button className="dyn-expand" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`${name} 큰 편집기 열기`} title="큰 편집기 (더블클릭)"><Icon name="fit" size={11}/></button>
        </div>
        <GrMeter feed={feed} height={116} range={kind === 'gate' ? 60 : 24} label={`${name} 게인 리덕션`}/>
      </div>
      <p className="dyn-chips" aria-live="off">
        {summary(kind, access).map(chip => <span key={chip.label}><small>{chip.label}</small>{chip.text}</span>)}
      </p>
      {vu && <VuNeedle feed={feed} width={104} label={`${name} VU 미터 (게인 리덕션)`}/>}
      <div className="dyn-knobs" style={{ '--cols': knobs.length } as React.CSSProperties}>
        {knobs.map(def => <Knob key={def.id} def={def} value={value(def.id)} onChange={v => onParam(def.id, v)} color={color} size={32}/>)}
      </div>
      {open && <DynamicsEditor {...access} kind={kind} feed={feed} name={name} label={label} enabled={device.enabled} vu={vu} color={color} onClose={() => setOpen(false)}/>}
    </div>
  )
}
