import { createContext, useContext } from 'react'
import { WAVE_PARAM_DEFINITIONS } from '../definition'
import type { WavetableModSource, WavetableParamId, WavetablePatch } from '../model'
import { Choice, PowerSwitch, SynthKnob } from './controls'
import { destinationName, sourceName } from './Matrix'

export interface EditorContext {
  patch: WavetablePatch
  setParameter: (id: WavetableParamId, value: number) => void
  selectedSource: WavetableModSource | null
  assign: (source: string, destination: WavetableParamId) => void
  inspect: (destination: WavetableParamId) => void
}
export const SynthEditorContext = createContext<EditorContext | null>(null)
export function useSynthEditor() {
  const context = useContext(SynthEditorContext)
  if (!context) throw new Error('IEUM WAVE controls need an editor provider.')
  return context
}
export function parameter(id: string) {
  const definition = WAVE_PARAM_DEFINITIONS.find(def => def.id === id)
  if (!definition) throw new Error('Unknown IEUM WAVE parameter: ' + id)
  return definition
}
export function ParamKnob({ id, label, compact = false }: { id: string; label?: string; compact?: boolean }) {
  const { patch, setParameter, selectedSource, assign, inspect } = useSynthEditor()
  const def = parameter(id)
  const modulatable = 'modulate' in def && def.modulate
  const routes = patch.routes.filter(route => route.destination === id).map(route => ({ ...route, name: sourceName(route.source) }))
  return <SynthKnob def={def} value={patch.params[def.id]} label={label} ariaLabel={destinationName(id)} compact={compact} onChange={value => setParameter(def.id, value)} modulations={routes}
    onAssign={modulatable ? source => assign(source, def.id) : undefined}
    onOpenModulation={modulatable ? () => selectedSource ? assign(selectedSource, def.id) : inspect(def.id) : undefined}/>
}
export function ParamChoice({ id, label }: { id: string; label?: string }) {
  const { patch, setParameter } = useSynthEditor(), def = parameter(id)
  return <Choice def={def} value={patch.params[def.id]} label={label} onChange={value => setParameter(def.id, value)}/>
}
export function ParamPower({ id, label }: { id: string; label: string }) {
  const { patch, setParameter } = useSynthEditor(), def = parameter(id)
  return <PowerSwitch enabled={patch.params[def.id] === 1} label={label} onChange={enabled => setParameter(def.id, enabled ? 1 : 0)}/>
}
