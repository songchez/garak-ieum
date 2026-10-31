import { useEffect, useRef } from 'react'
import { formatParam, fromNormalized, toNormalized, type ParamDef } from '../core/devices'

const SWEEP=135
const point=(c:number,r:number,deg:number)=>{const a=deg*Math.PI/180;return [c+r*Math.sin(a),c-r*Math.cos(a)]}
function arc(c:number,r:number,from:number,to:number){if(Math.abs(to-from)<.01)return '';const [a,b]=from<to?[from,to]:[to,from];const [x1,y1]=point(c,r,a),[x2,y2]=point(c,r,b);return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${b-a>180?1:0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`}
const angleOf=(n:number)=>-SWEEP+n*SWEEP*2

export function Knob({def,value,onChange,color='var(--seokganju-60)',size=38}:{def:ParamDef;value:number;onChange:(v:number)=>void;color?:string;size?:number}){
  const ref=useRef<HTMLDivElement>(null)
  const latest=useRef({def,value,onChange})
  latest.current={def,value,onChange}
  const cancelDrag=useRef<(()=>void)|null>(null)
  const set=(next:number)=>{const l=latest.current;const v=Math.min(l.def.max,Math.max(l.def.min,next));if(v!==l.value)l.onChange(v)}
  const step=(direction:number,amount:number)=>{const {def:d,value:v}=latest.current;if(d.options){const index=Math.max(0,d.options.findIndex(o=>o.value===v));set(d.options[Math.max(0,Math.min(d.options.length-1,index+direction))].value)}else set(fromNormalized(d,toNormalized(d,v)+direction*amount))}
  useEffect(()=>{
    const el=ref.current;if(!el)return
    // Ctrl/⌘/Alt + wheel belongs to the rack zoom.
    const wheel=(e:WheelEvent)=>{if(!e.deltaY||e.ctrlKey||e.metaKey||e.altKey)return;e.preventDefault();step(e.deltaY<0?1:-1,e.shiftKey?.005:.02)}
    el.addEventListener('wheel',wheel,{passive:false})
    return()=>{el.removeEventListener('wheel',wheel);cancelDrag.current?.()}
  },[])
  function startDrag(e:React.PointerEvent<HTMLDivElement>){
    if(e.button!==0)return
    e.preventDefault();cancelDrag.current?.()
    const el=e.currentTarget,pointerId=e.pointerId,startValue=latest.current.value
    el.focus({preventScroll:true})
    let normalized=toNormalized(latest.current.def,startValue),lastY=e.clientY,active=true
    el.dataset.dawGesture='knob'
    const move=(event:PointerEvent)=>{if(!active||event.pointerId!==pointerId)return;const dy=lastY-event.clientY;lastY=event.clientY;normalized=Math.min(1,Math.max(0,normalized+dy/(event.shiftKey?800:160)));set(fromNormalized(latest.current.def,normalized))}
    const finish=(restore:boolean)=>{
      if(!active)return
      active=false;cancelDrag.current=null
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancelPointer)
      window.removeEventListener('keydown',key,true);window.removeEventListener('blur',blur)
      el.removeEventListener('lostpointercapture',lost);delete el.dataset.dawGesture
      if(el.hasPointerCapture(pointerId))el.releasePointerCapture(pointerId)
      if(restore)set(startValue)
    }
    const up=(event:PointerEvent)=>{if(event.pointerId===pointerId)finish(false)}
    const cancelPointer=(event:PointerEvent)=>{if(event.pointerId===pointerId)finish(false)}
    const lost=()=>finish(false)
    const blur=()=>finish(false)
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(true)}}
    cancelDrag.current=()=>finish(false)
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancelPointer)
    window.addEventListener('keydown',key,true);window.addEventListener('blur',blur)
    el.addEventListener('lostpointercapture',lost)
    try{el.setPointerCapture(pointerId)}catch{/* window listeners still finish the drag */}
  }
  function keyDown(e:React.KeyboardEvent){
    const fine=e.shiftKey
    switch(e.key){
      case 'ArrowUp':case 'ArrowRight':step(1,fine?.1:.01);break
      case 'ArrowDown':case 'ArrowLeft':step(-1,fine?.1:.01);break
      case 'PageUp':step(1,.1);break
      case 'PageDown':step(-1,.1);break
      case 'Home':set(def.options?def.options[0].value:def.min);break
      case 'End':set(def.options?def.options[def.options.length-1].value:def.max);break
      default:return
    }
    e.preventDefault();e.stopPropagation()
  }
  const c=20,r=15,n=toNormalized(def,value),angle=angleOf(n)
  const origin=def.min<0&&def.max>0&&!def.options?angleOf(toNormalized(def,0)):-SWEEP
  const [px,py]=point(c,r-3,angle),[ix,iy]=point(c,6,angle)
  const text=formatParam(def,value)
  return <div ref={ref} className="knob" role="slider" tabIndex={0} aria-label={def.label} aria-valuemin={def.min} aria-valuemax={def.max} aria-valuenow={value} aria-valuetext={text} title={`${def.label} · ${text} (더블 클릭: 기본값)`} onPointerDown={startDrag} onKeyDown={keyDown} onDoubleClick={()=>set(def.default)} style={{'--knob-size':`${size}px`} as React.CSSProperties}>
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><circle cx={c} cy={c} r={11} className="knob-cap"/><path d={arc(c,r,-SWEEP,SWEEP)} className="knob-track"/><path d={arc(c,r,origin,angle)} className="knob-value" style={{stroke:color}}/><line x1={ix} y1={iy} x2={px} y2={py} className="knob-pointer"/></svg>
    <span className="knob-readout">{text}</span>
    <span className="knob-label">{def.label}</span>
  </div>
}
