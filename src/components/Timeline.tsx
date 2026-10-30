import { memo, useEffect, useRef, useState } from 'react'
import type { AudioAsset, AudioEngine, Clip, Project, Track } from '../core/types'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import { crossedDragThreshold, isShortcutSuppressed, isUnmodified, snapDragDelta } from '../core/input'

interface Props {
  project: Project; assets: Map<string,AudioAsset>; engine: AudioEngine
  selectedTrackId:string; selectedClipId:string|null; pixelsPerBeat:number; snap:number
  onSelect:(trackId:string,clipId?:string)=>void
  onTrackChange:(id:string,patch:Partial<Track>)=>void
  onClipMove:(trackId:string,clipId:string,start:number,length?:number)=>void
  onAddClip:(trackId:string,beat:number)=>void
  onAudioDrop:(files:FileList,trackId?:string,beat?:number)=>void
  onAddTrack:()=>void
}
export function Timeline(props:Props){
  const {project,assets,engine,selectedTrackId,selectedClipId,pixelsPerBeat:ppb,snap}=props
  const scrollRef=useRef<HTMLDivElement>(null)
  const [dragging,setDragging]=useState(false)
  const width=Math.max(project.lengthBeats,...project.tracks.flatMap(t=>t.clips.map(c=>c.startBeat+c.lengthBeats))) * ppb
  return <div className={`arrangement ${dragging?'file-over':''}`} data-keyboard-scope="timeline" tabIndex={-1} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href]'))e.currentTarget.focus({preventScroll:true})}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false)}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();setDragging(false);props.onAudioDrop(e.dataTransfer.files)}}}>
    <div className="arrangement-title"><div><span className="eyebrow">WORKSPACE</span><strong>어레인지먼트</strong><span className="subtle-count">{project.tracks.length} tracks</span></div><span className="arrangement-hint">파일을 드래그해 새로운 소리를 더하세요 <Icon name="upload" size={14}/></span></div>
    <div className="timeline-scroll" ref={scrollRef}>
      <div className="timeline-sheet" style={{width:width+208,minWidth:'100%'}}>
        <div className="timeline-ruler-row">
          <div className="track-ruler-label">TRACKS <span>4/4</span></div>
          <div className="timeline-ruler" style={{width}} onPointerDown={e=>{if(e.button!==0)return;const x=e.clientX-e.currentTarget.getBoundingClientRect().left;engine.seek(Math.max(0,Math.min(project.lengthBeats,x/ppb)))}} title="클릭하여 재생 위치 이동">
            {Array.from({length:Math.ceil(width/(ppb*4))},(_,i)=><div className="bar-number" key={i} style={{left:i*4*ppb,width:ppb*4}}>{i+1}</div>)}
            {project.loop.enabled&&<div className="loop-region" style={{left:project.loop.startBeat*ppb,width:(project.loop.endBeat-project.loop.startBeat)*ppb}}><span/><span/></div>}
          </div>
        </div>
        {project.tracks.map((track,index)=><div className={`track-row ${selectedTrackId===track.id?'selected-track':''}`} key={track.id} style={{'--track-color':track.color} as React.CSSProperties}>
          <div className="track-header" onClick={()=>props.onSelect(track.id)}>
            <span className="track-number">{String(index+1).padStart(2,'0')}</span>
            <span className="track-symbol"><Icon name={track.kind==='audio'?'wave':track.instrument==='drums'?'drum':track.instrument==='keys'?'keys':'synth'} size={17}/></span>
            <div className="track-heading"><span className="track-name" title={track.name}>{track.name}</span><div className="track-controls"><button className={track.mute?'mute active':'mute'} title="뮤트" aria-label={`${track.name} 뮤트`} aria-pressed={track.mute} onClick={e=>{e.stopPropagation();props.onTrackChange(track.id,{mute:!track.mute})}}>M</button><button className={track.solo?'solo active':'solo'} title="솔로" aria-label={`${track.name} 솔로`} aria-pressed={track.solo} onClick={e=>{e.stopPropagation();props.onTrackChange(track.id,{solo:!track.solo})}}>S</button><span className="track-kind">{track.kind==='audio'?'AUDIO':'MIDI'}</span></div></div>
            <MiniMeter engine={engine} trackId={track.id} color={track.color}/>
          </div>
          <div className="track-lane" style={{width,backgroundSize:`${ppb*4}px 100%, ${ppb}px 100%`}} onPointerDown={e=>{if(e.target===e.currentTarget)props.onSelect(track.id)}} onDoubleClick={e=>{if(e.target!==e.currentTarget)return;props.onAddClip(track.id,Math.floor((e.clientX-e.currentTarget.getBoundingClientRect().left)/ppb/4)*4)}} onDragOver={e=>{if(e.dataTransfer.files||e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();setDragging(false);const beat=Math.floor((e.clientX-e.currentTarget.getBoundingClientRect().left)/ppb/4)*4;props.onAudioDrop(e.dataTransfer.files,track.kind==='audio'?track.id:undefined,Math.max(0,beat))}}}>
            {track.clips.map(clip=><TimelineClip key={clip.id} clip={clip} track={track} asset={clip.kind==='audio'?assets.get(clip.assetId):undefined} ppb={ppb} snap={snap} selected={selectedClipId===clip.id} onSelect={()=>props.onSelect(track.id,clip.id)} onMove={(start,length)=>props.onClipMove(track.id,clip.id,start,length)}/>)}
            {!track.clips.length&&<span className="empty-lane-hint">{track.kind==='audio'?'오디오 파일을 여기에 놓으세요':'더블 클릭하여 MIDI 클립 만들기'}</span>}
          </div>
        </div>)}
        <div className="add-track-row"><button onClick={props.onAddTrack}><Icon name="plus" size={15}/> 트랙 추가</button><div style={{width,backgroundSize:`${ppb*4}px 100%`}}/></div>
        <Playhead engine={engine} ppb={ppb}/>
      </div>
    </div>
    {dragging&&<div className="drop-overlay"><Icon name="wave" size={32}/><strong>오디오를 프로젝트에 추가합니다</strong><span>파일은 이 브라우저에 저장됩니다</span></div>}
  </div>
}

const TimelineClip=memo(function TimelineClip({clip,track,asset,ppb,snap,selected,onSelect,onMove}:{clip:Clip;track:Track;asset?:AudioAsset;ppb:number;snap:number;selected:boolean;onSelect:()=>void;onMove:(start:number,length?:number)=>void}){
  const [draft,setDraft]=useState<{start:number;length:number}|null>(null)
  const cancelDrag=useRef<((render?:boolean)=>void)|null>(null)
  useEffect(()=>()=>cancelDrag.current?.(false),[])
  function startDrag(e:React.PointerEvent,resize=false){
    if(e.button!==0)return
    e.stopPropagation();e.preventDefault();cancelDrag.current?.();onSelect()
    const target=e.currentTarget.closest<HTMLElement>('.timeline-clip')??e.currentTarget as HTMLElement
    target.focus({preventScroll:true})
    const pointerId=e.pointerId,origin=e.clientX,original=clip.startBeat,originalLength=clip.lengthBeats
    const scroll=target.closest<HTMLElement>('.timeline-scroll'),scrollOrigin=scroll?.scrollLeft??0
    let latest={start:original,length:originalLength},activated=false,active=true
    target.dataset.dawGesture=resize?'resize':'move'
    const move=(event:PointerEvent)=>{
      if(!active||event.pointerId!==pointerId)return
      const dx=event.clientX-origin+(scroll?.scrollLeft??0)-scrollOrigin
      if(!activated&&!crossedDragThreshold(dx))return
      activated=true
      const delta=snapDragDelta(dx/ppb,snap)
      latest=resize?{start:original,length:Math.max(snap||.25,originalLength+delta)}:{start:Math.max(0,original+delta),length:originalLength}
      setDraft(latest)
    }
    const finish=(commit:boolean,render=true)=>{
      if(!active)return
      active=false;cancelDrag.current=null
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up)
      window.removeEventListener('pointercancel',cancelPointer);window.removeEventListener('blur',cancel)
      window.removeEventListener('keydown',key,true);document.removeEventListener('visibilitychange',visibility)
      target.removeEventListener('lostpointercapture',cancelPointer);delete target.dataset.dawGesture
      if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId)
      if(render)setDraft(null)
      if(commit&&activated&&(Math.abs(latest.start-original)>1e-8||Math.abs(latest.length-originalLength)>1e-8))onMove(latest.start,resize?latest.length:undefined)
    }
    const up=(event:PointerEvent)=>{if(event.pointerId!==pointerId)return;move(event);finish(true)}
    const cancel=()=>finish(false)
    const cancelPointer=(event:PointerEvent)=>{if(event.pointerId===pointerId)finish(false)}
    const visibility=()=>{if(document.hidden)finish(false)}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&isUnmodified(event)&&!isShortcutSuppressed(event)){event.preventDefault();event.stopPropagation();finish(false)}}
    cancelDrag.current=(render=true)=>finish(false,render)
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up)
    window.addEventListener('pointercancel',cancelPointer);window.addEventListener('blur',cancel)
    window.addEventListener('keydown',key,true);document.addEventListener('visibilitychange',visibility)
    target.addEventListener('lostpointercapture',cancelPointer)
    try{target.setPointerCapture(pointerId)}catch{/* Blur/cancel listeners remain a fallback if capture is unavailable. */}
  }
  const notes=clip.kind==='midi'?clip.notes:[]
  const min=notes.length?Math.min(...notes.map(n=>n.pitch)):48,max=notes.length?Math.max(...notes.map(n=>n.pitch)):72
  return <div className={`timeline-clip ${selected?'clip-selected':''} ${draft?'clip-moving':''} ${clip.kind}`} tabIndex={0} role="button" aria-label={`${clip.name}, ${clip.startBeat/4+1} 마디`} onFocus={onSelect} onPointerDown={e=>startDrag(e)} onKeyDown={e=>{if(e.key==='Enter'&&isUnmodified(e.nativeEvent)&&!isShortcutSuppressed(e.nativeEvent,true)){e.preventDefault();e.stopPropagation();if(!e.repeat)onSelect()}}} style={{left:(draft?.start??clip.startBeat)*ppb,width:(draft?.length??clip.lengthBeats)*ppb-2,'--clip-color':track.color} as React.CSSProperties}>
    <div className="clip-title"><Icon name={clip.kind==='audio'?'wave':'note'} size={11}/><span>{clip.name}</span><span className="clip-corner-dot"/></div>
    <div className="clip-preview">{clip.kind==='audio'&&asset?<Waveform peaks={asset.peaks}/>:<svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${clip.lengthBeats*20} 32`} aria-hidden="true">{notes.filter(n=>n.start<clip.lengthBeats).map(n=><rect key={n.id} x={n.start*20} y={3+(1-(n.pitch-min)/Math.max(12,max-min))*23} width={Math.max(1,Math.min(n.duration,clip.lengthBeats-n.start)*20-1)} height={track.instrument==='drums'?4:2.5} rx=".7" fill="currentColor" opacity={.45+n.velocity*.5}/>)}</svg>}</div>
    <div className="clip-resize" title="드래그하여 클립 길이 조절" onPointerDown={e=>startDrag(e,true)}/>
  </div>
})

function Playhead({engine,ppb}:{engine:AudioEngine;ppb:number}){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{let raf=0;const frame=()=>{if(ref.current)ref.current.style.transform=`translateX(${engine.getSnapshot().beat*ppb}px)`;raf=requestAnimationFrame(frame)};frame();return()=>cancelAnimationFrame(raf)},[engine,ppb])
  return <div className="playhead" ref={ref}><i/></div>
}
export function MiniMeter({engine,trackId,color='#a8e8cb',vertical=false}:{engine:AudioEngine;trackId?:string;color?:string;vertical?:boolean}){
  const ref=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{let raf=0;let held=0;let last=0;const frame=(now:number)=>{if(now-last>33){last=now;const c=ref.current;const ctx=c?.getContext('2d');if(c&&ctx){const value=trackId?engine.getTrackLevel(trackId):engine.getMasterLevel();held=Math.max(value,held*.88);const fill=Math.min(1,Math.sqrt(held)*1.6);ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#2a2d32';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle=held>.85?'#f99e98':color;if(vertical)ctx.fillRect(0,c.height*(1-fill),c.width,c.height*fill);else ctx.fillRect(0,0,c.width*fill,c.height)}}raf=requestAnimationFrame(frame)};raf=requestAnimationFrame(frame);return()=>cancelAnimationFrame(raf)},[engine,trackId,color,vertical])
  return <canvas ref={ref} width={vertical?5:38} height={vertical?120:4} className={vertical?'meter-vertical':'mini-meter'} aria-label="실시간 오디오 레벨"/>
}
