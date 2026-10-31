import { INSTRUMENTS, INSTRUMENT_SECTIONS } from '../core/instruments'

/** <optgroup> list for instrument <select>s, grouped like the browser panel. */
export function InstrumentOptions(){
  return <>{INSTRUMENT_SECTIONS.map(section=><optgroup key={section.title} label={section.title}>{INSTRUMENTS.filter(i=>section.categories.includes(i.category)).map(i=><option key={i.id} value={i.id}>{i.name} · {i.nameKo}</option>)}</optgroup>)}</>
}
