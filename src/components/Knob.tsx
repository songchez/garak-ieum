import { useEffect, useRef } from 'react'
import { formatParam, fromNormalized, toNormalized, type ParamDef } from '../core/devices'
import { useHistoryGesture } from '../core/historyGesture'

const SWEEP=135
const point=(c:number,r:number,deg:number)=>{const a=deg*Math.PI/180;return [c+r*Math.sin(a),c-r*Math.cos(a)]}
function arc(c:number,r:number,from:number,to:number){if(Math.abs(to-from)<.01)return '';const [a,b]=from<to?[from,to]:[to,from];const [x1,y1]=point(c,r,a),[x2,y2]=point(c,r,b);return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${b-a>180?1:0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`}
const angleOf=(n:number)=>-SWEEP+n*SWEEP*2

export function Knob({def,value,onChange,color='var(--accent)',size=38,imageSrc,ariaLabel,formatValue}:{def:ParamDef;value:number;onChange:(v:number)=>void;color?:string;size?:number;imageSrc?:string;ariaLabel?:string;formatValue?:(value:number)=>string}){
  const ref=useRef<HTMLDivElement>(null)
  const latest=useRef({def,value,onChange})
  latest.current={def,value,onChange}
  const cancelDrag=useRef<(()=>void)|null>(null)
  const wheelTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const gesture=useHistoryGesture(`${ariaLabel??def.label} 조절`)
  const gestureRef=useRef(gesture);gestureRef.current=gesture
  const set=(next:number)=>{const l=latest.current;const v=Math.min(l.def.max,Math.max(l.def.min,next));if(v!==l.value){l.value=v;l.onChange(v)}}
  const step=(direction:number,amount:number)=>{const {def:d,value:v}=latest.current;if(d.options){const index=Math.max(0,d.options.findIndex(o=>o.value===v));set(d.options[Math.max(0,Math.min(d.options.length-1,index+direction))].value)}else set(fromNormalized(d,toNormalized(d,v)+direction*amount))}
  useEffect(()=>{
    const el=ref.current;if(!el)return
    // Ctrl/⌘/Alt + wheel belongs to the rack zoom.
    const wheel=(e:WheelEvent)=>{if(!e.deltaY||e.ctrlKey||e.metaKey||e.altKey)return;e.preventDefault();if(cancelDrag.current)return;gestureRef.current.begin();step(e.deltaY<0?1:-1,e.shiftKey?.005:.02);clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>{wheelTimer.current=undefined;gestureRef.current.end()},180)}
    el.addEventListener('wheel',wheel,{passive:false})
    return()=>{el.removeEventListener('wheel',wheel);clearTimeout(wheelTimer.current);cancelDrag.current?.();gestureRef.current.end()}
  },[])
  function startDrag(e:React.PointerEvent<HTMLDivElement>){
    if(e.button!==0)return
    e.preventDefault();cancelDrag.current?.()
    if(wheelTimer.current!==undefined){clearTimeout(wheelTimer.current);wheelTimer.current=undefined;gestureRef.current.end()}
    gestureRef.current.begin()
    if(e.altKey){set(latest.current.def.default);gestureRef.current.end();return}
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
      const cancelled=restore||Math.abs(latest.current.value-startValue)<1e-9
      if(restore)set(startValue)
      if(cancelled)gestureRef.current.cancel();else gestureRef.current.end()
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
    if(e.ctrlKey||e.metaKey||e.altKey||e.nativeEvent.isComposing)return
    if(!['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','PageUp','PageDown','Home','End'].includes(e.key))return
    if(wheelTimer.current!==undefined){clearTimeout(wheelTimer.current);wheelTimer.current=undefined;gestureRef.current.end()}
    gestureRef.current.begin()
    const fine=e.shiftKey
    switch(e.key){
      case 'ArrowUp':case 'ArrowRight':step(1,fine?.001:.01);break
      case 'ArrowDown':case 'ArrowLeft':step(-1,fine?.001:.01);break
      case 'PageUp':step(1,.1);break
      case 'PageDown':step(-1,.1);break
      case 'Home':set(def.options?def.options[0].value:def.min);break
      case 'End':set(def.options?def.options[def.options.length-1].value:def.max);break
      default:return
    }
    e.preventDefault();e.stopPropagation()
  }
  function keyUp(e:React.KeyboardEvent){if(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','PageUp','PageDown','Home','End'].includes(e.key)){e.stopPropagation();gestureRef.current.end()}}
  const c=20,r=15,n=toNormalized(def,value),angle=angleOf(n)
  const origin=def.min<0&&def.max>0&&!def.options?angleOf(toNormalized(def,0)):-SWEEP
  const [px,py]=point(c,r-3,angle),[ix,iy]=point(c,6,angle)
  const text=formatValue?formatValue(value):formatParam(def,value)
  return <div ref={ref} className={`knob${imageSrc?' knob--image':''}`} role="slider" tabIndex={0} aria-label={ariaLabel??def.label} aria-valuemin={def.min} aria-valuemax={def.max} aria-valuenow={value} aria-valuetext={text} title={`${ariaLabel??def.label} · ${text} (Shift: 미세 조절 · 더블 클릭·Alt/⌥클릭: 기본값)`} onPointerDown={startDrag} onKeyDown={keyDown} onKeyUp={keyUp} onBlur={()=>{if(!cancelDrag.current)gestureRef.current.end()}} onDoubleClick={()=>{gestureRef.current.begin();set(def.default);gestureRef.current.end()}} style={{'--knob-size':`${size}px`} as React.CSSProperties}>
    {imageSrc?<span className="knob-image-visual" style={{width:size,height:size}} aria-hidden="true">
      <span className="knob-image-shadow"/>
      <svg className="knob-image-scale" viewBox="0 0 64 64"><path d={arc(32,29,-SWEEP,SWEEP)} className="knob-image-track"/>{Array.from({length:11},(_,i)=>{const a=angleOf(i/10),[x1,y1]=point(32,27,a),[x2,y2]=point(32,31,a);return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}/>})}</svg>
      <img className="knob-image-cap" src={imageSrc} alt="" draggable={false} width={size} height={size} style={{transform:`rotate(${angle}deg)`}}/>
    </span>:<svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true"><circle cx={c} cy={c} r={11} className="knob-cap"/><path d={arc(c,r,-SWEEP,SWEEP)} className="knob-track"/><path d={arc(c,r,origin,angle)} className="knob-value" style={{stroke:color}}/><line x1={ix} y1={iy} x2={px} y2={py} className="knob-pointer"/></svg>}
    <span className="knob-readout">{text}</span>
    <span className="knob-label">{def.label}</span>
  </div>
}
