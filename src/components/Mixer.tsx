import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AudioEngine, Project, Track } from '../core/types'
import { ZOOM_LIMITS, clampZoom, fitScale, zoomBy, type ZoomHandle, type ZoomState } from '../core/zoom'
import { MiniMeter } from './Timeline'
import { Icon } from './Icon'
import ContextMenu from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
const stop=(e:React.SyntheticEvent)=>e.stopPropagation()
const isolate={onClick:stop,onPointerDown:stop,onDoubleClick:stop}
type MixerZoom=ZoomState['mixer']
export default function Mixer({project,engine,onTrackChange,onMasterChange,selectedTrackId,onSelect,onDeleteTrack,onDuplicateTrack,zoom={channelWidth:110,faderHeight:110},onZoomChange,zoomRef}:{project:Project;engine:AudioEngine;onTrackChange:(id:string,patch:Partial<Track>)=>void;onMasterChange:(value:number)=>void;selectedTrackId:string;onSelect:(id:string)=>void;onDeleteTrack?:(id:string)=>void;onDuplicateTrack?:(id:string)=>void;zoom?:MixerZoom;onZoomChange?:(zoom:MixerZoom)=>void;zoomRef?:RefObject<ZoomHandle|null>}){
  const rootRef=useRef<HTMLDivElement>(null),channelsRef=useRef<HTMLDivElement>(null)
  const anchor=useRef<{pos:number;px:number}|null>(null)
  const width=Math.round(zoom.channelWidth),fader=Math.round(zoom.faderHeight)
  /** Channel width zoom keeps the channel under the pointer (default: the left edge) in place. */
  function zoomWidth(factor:number,px=0){const next=zoomBy(zoom.channelWidth,factor,ZOOM_LIMITS.mixerWidth);if(Math.abs(next-zoom.channelWidth)<.01)return;const el=channelsRef.current;if(el)anchor.current={pos:(el.scrollLeft+px)/width,px};onZoomChange?.({...zoom,channelWidth:next})}
  function zoomFader(factor:number){const next=zoomBy(zoom.faderHeight,factor,ZOOM_LIMITS.mixerFader);if(Math.abs(next-zoom.faderHeight)>=.01)onZoomChange?.({...zoom,faderHeight:next})}
  /** Every channel across the width, faders as tall as the panel allows. */
  function fit(){
    const el=channelsRef.current,strip=el?.querySelector<HTMLElement>('.mixer-channel');if(!el)return
    const channelWidth=Math.floor(fitScale(Math.max(1,project.tracks.length),el.clientWidth,ZOOM_LIMITS.mixerWidth))
    let faderHeight=zoom.faderHeight
    if(strip){const cs=getComputedStyle(strip);const used=[...strip.children].filter((c):c is HTMLElement=>c instanceof HTMLElement&&getComputedStyle(c).position!=='absolute').reduce((sum,c)=>{const s=getComputedStyle(c);return sum+c.offsetHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom)},0)+parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);faderHeight=Math.floor(clampZoom(el.clientHeight-(used-fader)-2,ZOOM_LIMITS.mixerFader))}
    anchor.current={pos:0,px:0};onZoomChange?.({channelWidth,faderHeight})
  }
  useZoomHandle(zoomRef,{zoom:(axis,factor)=>axis==='x'?zoomWidth(factor):zoomFader(factor),fit})
  useZoomWheel(rootRef,{onZoomX:(factor,x)=>zoomWidth(factor,x),onZoomY:factor=>zoomFader(factor)})
  useLayoutEffect(()=>{const a=anchor.current;anchor.current=null;const el=channelsRef.current;if(a&&el)el.scrollLeft=Math.max(0,a.pos*width-a.px)})
  const [editingId,setEditingId]=useState<string|null>(null)
  const [menu,setMenu]=useState<{id:string;x:number;y:number;trigger?:HTMLElement}|null>(null)
  const renameDone=useRef(false)
  const hasMenu=!!(onDeleteTrack||onDuplicateTrack)
  function startRename(id:string){renameDone.current=false;setEditingId(id)}
  function finishRename(track:Track,value:string|null){if(renameDone.current)return;renameDone.current=true;setEditingId(null);const name=value?.trim();if(name&&name!==track.name)onTrackChange(track.id,{name})}
  function menuItems(track:Track):ContextMenuItem[]{return[{label:'이름 바꾸기',onSelect:()=>startRename(track.id)},...(onDuplicateTrack?[{label:'복제',onSelect:()=>onDuplicateTrack(track.id)}]:[]),...(onDeleteTrack?[{type:'separator'} as const,{label:'삭제',danger:true,onSelect:()=>onDeleteTrack(track.id)}]:[])]}
  const menuTrack=menu&&project.tracks.find(t=>t.id===menu.id)
  return <div className="mixer" ref={rootRef} data-keyboard-scope="mixer" tabIndex={-1} aria-label="믹서" style={{'--ch-w':`${width}px`,'--fader-h':`${fader}px`} as React.CSSProperties} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href]'))e.currentTarget.focus({preventScroll:true})}}><div className="mixer-channels" ref={channelsRef}>{project.tracks.map((track,i)=><div className={`mixer-channel ${selectedTrackId===track.id?'selected':''}`} key={track.id} onClick={()=>onSelect(track.id)} onContextMenu={e=>{e.preventDefault();setMenu({id:track.id,x:e.clientX,y:e.clientY})}} style={{'--track-color':track.color} as React.CSSProperties}>
    {hasMenu&&<button type="button" className="channel-menu-button" {...isolate} onClick={e=>{e.stopPropagation();const trigger=e.currentTarget,r=trigger.getBoundingClientRect();setMenu(m=>m?.trigger===trigger?null:{id:track.id,x:r.left,y:r.bottom+2,trigger})}} aria-label={`${track.name} 채널 메뉴`} aria-haspopup="menu" aria-expanded={menu?.id===track.id} title="채널 메뉴">⋯</button>}
    <div className="channel-heading"><span>{String(i+1).padStart(2,'0')}</span>{editingId===track.id
      ?<input className="channel-rename" autoFocus defaultValue={track.name} aria-label={`${track.name} 이름 바꾸기`} {...isolate} onContextMenu={stop} onFocus={e=>e.currentTarget.select()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finishRename(track,e.currentTarget.value)}else if(e.key==='Escape'){e.preventDefault();finishRename(track,null)}}} onBlur={e=>finishRename(track,e.currentTarget.value)}/>
      :<strong title={`${track.name} · 더블클릭하여 이름 바꾸기`} onDoubleClick={e=>{e.stopPropagation();startRename(track.id)}}>{track.name}</strong>}</div>
    <div className="channel-pan"><span>L</span><input type="range" min="-1" max="1" step="0.01" value={track.pan} {...isolate} onChange={e=>onTrackChange(track.id,{pan:+e.target.value})} aria-label={`${track.name} 팬`}/><span>R</span></div>
    <div className="channel-fader"><div className="fader-scale"><span>+6</span><span>0</span><span>−12</span><span>−∞</span></div><input className="vertical-fader" type="range" min="0" max="1.5" step="0.01" value={track.volume} {...isolate} onChange={e=>onTrackChange(track.id,{volume:+e.target.value})} aria-label={`${track.name} 볼륨`}/><MiniMeter engine={engine} trackId={track.id} vertical color={track.color}/></div>
    <span className="channel-db">{track.volume>0?(20*Math.log10(track.volume)).toFixed(1):'−∞'} dB</span>
    <div className="channel-buttons"><button className={track.mute?'active mute':'mute'} {...isolate} onClick={e=>{e.stopPropagation();onTrackChange(track.id,{mute:!track.mute})}} aria-label={`${track.name} 뮤트`} aria-pressed={track.mute}>M</button><button className={track.solo?'active solo':'solo'} {...isolate} onClick={e=>{e.stopPropagation();onTrackChange(track.id,{solo:!track.solo})}} aria-label={`${track.name} 솔로`} aria-pressed={track.solo}>S</button></div>
  </div>)}</div><div className="mixer-master"><strong><Icon name="volume" size={14}/> MASTER</strong><div className="channel-fader"><input className="vertical-fader" type="range" min="0" max="1.5" step="0.01" value={project.masterVolume} onChange={e=>onMasterChange(+e.target.value)} aria-label="마스터 볼륨"/><MiniMeter engine={engine} vertical/></div><span className="channel-db">{project.masterVolume>0?(20*Math.log10(project.masterVolume)).toFixed(1):'−∞'} dB</span><span className="master-out">Stereo out</span></div>
  {menu&&menuTrack&&<ContextMenu x={menu.x} y={menu.y} items={menuItems(menuTrack)} onClose={()=>setMenu(null)} trigger={menu.trigger} label={`${menuTrack.name} 채널 메뉴`}/>}</div>
}
