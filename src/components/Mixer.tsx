import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AudioEngine, EffectType, InstrumentId, Project, Track } from '../core/types'
import { effectiveArm, implicitlyMuted, type TrackButtonKind, type TrackButtonMods } from '../core/trackActions'
import { shortcutLabel } from '../core/input'
import { ZOOM_LIMITS, clampZoom, fitScale, zoomBy, type ZoomHandle, type ZoomState } from '../core/zoom'
import { ChannelStrip } from './ChannelStrip'
import ContextMenu from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
type MixerZoom=ZoomState['mixer']
export interface MixerProps{
  project:Project;engine:AudioEngine;recording:boolean;focusedTrackId:string;selectedTrackIds:ReadonlySet<string>
  onTrackClick:(id:string,mods:{range:boolean;toggle:boolean;trackOnly:boolean})=>void
  onTrackChange:(id:string,patch:Partial<Track>,key?:string)=>void
  onTrackButton:(trackId:string,kind:TrackButtonKind,mods:TrackButtonMods)=>void
  onTrackSweep:(trackId:string,kind:TrackButtonKind,value:boolean)=>void
  onInstrumentChange:(trackId:string,instrument:InstrumentId)=>void
  onAddDevice:(trackId:string,type:EffectType)=>void
  onToggleDevice:(trackId:string,deviceId:string)=>void
  onMoveDevice:(trackId:string,deviceId:string,offset:number)=>void
  onRemoveDevice:(trackId:string,deviceId:string)=>void
  onOpenDevices:(trackId:string,deviceId?:string)=>void
  onMasterChange:(value:number)=>void
  onOpenColorPalette:(trackId:string,e:React.MouseEvent)=>void
  onIconMenu:(trackId:string,e:React.MouseEvent)=>void
  onDuplicateTracks:(ids:string[],mode:'settings'|'content')=>void
  onDeleteTracks:(ids:string[])=>void
  onColorPalette:(ids:string[],at:{x:number;y:number})=>void
  zoom?:MixerZoom;onZoomChange?:(zoom:MixerZoom)=>void;zoomRef?:RefObject<ZoomHandle|null>
}
/** One ChannelStrip per track (hidden tracks included, M-10) plus the Stereo Out strip; strips share the header's button semantics. */
export default function Mixer({project,engine,recording,focusedTrackId,selectedTrackIds,onTrackClick,onDuplicateTracks,onDeleteTracks,onColorPalette,zoom={channelWidth:110,faderHeight:110},onZoomChange,zoomRef,...strip}:MixerProps){
  const rootRef=useRef<HTMLDivElement>(null),channelsRef=useRef<HTMLDivElement>(null)
  const anchor=useRef<{pos:number;px:number}|null>(null)
  const width=Math.round(zoom.channelWidth),fader=Math.round(zoom.faderHeight)
  /** Channel width zoom keeps the channel under the pointer (default: the left edge) in place. */
  function zoomWidth(factor:number,px=0){const next=zoomBy(zoom.channelWidth,factor,ZOOM_LIMITS.mixerWidth);if(Math.abs(next-zoom.channelWidth)<.01)return;const el=channelsRef.current;if(el)anchor.current={pos:(el.scrollLeft+px)/width,px};onZoomChange?.({...zoom,channelWidth:next})}
  function zoomFader(factor:number){const next=zoomBy(zoom.faderHeight,factor,ZOOM_LIMITS.mixerFader);if(Math.abs(next-zoom.faderHeight)>=.01)onZoomChange?.({...zoom,faderHeight:next})}
  /** Every channel across the width, faders as tall as the panel allows. */
  function fit(){
    const el=channelsRef.current,first=el?.querySelector<HTMLElement>('.cstrip');if(!el)return
    const channelWidth=Math.floor(fitScale(Math.max(1,project.tracks.length),el.clientWidth-8,ZOOM_LIMITS.mixerWidth))
    let faderHeight=zoom.faderHeight
    if(first){const faderEl=first.querySelector<HTMLElement>('.cstrip-fader');const used=first.offsetHeight-(faderEl?.offsetHeight??fader);faderHeight=Math.floor(clampZoom(el.clientHeight-used-10,ZOOM_LIMITS.mixerFader))}
    anchor.current={pos:0,px:0};onZoomChange?.({channelWidth,faderHeight})
  }
  useZoomHandle(zoomRef,{zoom:(axis,factor)=>axis==='x'?zoomWidth(factor):zoomFader(factor),fit})
  useZoomWheel(rootRef,{onZoomX:(factor,x)=>zoomWidth(factor,x),onZoomY:factor=>zoomFader(factor)})
  useLayoutEffect(()=>{const a=anchor.current;anchor.current=null;const el=channelsRef.current;if(a&&el)el.scrollLeft=Math.max(0,a.pos*width-a.px)})
  const [editingId,setEditingId]=useState<string|null>(null)
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null)
  const renameDone=useRef(false)
  function startRename(id:string){renameDone.current=false;setEditingId(id)}
  function finishRename(track:Track,value:string|null){if(renameDone.current)return;renameDone.current=true;setEditingId(null);const name=value?.trim();if(name&&name!==track.name)strip.onTrackChange(track.id,{name},`${track.id}:name`)}
  const targets=(id:string)=>selectedTrackIds.has(id)?[...selectedTrackIds]:[id]
  function menuItems(track:Track):ContextMenuItem[]{const ids=targets(track.id),n=ids.length;return[{label:n>1?`${n}개 트랙 이름 변경`:'트랙 이름 변경',shortcut:shortcutLabel('renameTrack'),onSelect:()=>startRename(track.id)},{type:'separator'},{label:'설정을 복제한 새로운 트랙',shortcut:shortcutLabel('duplicateTrack'),onSelect:()=>onDuplicateTracks(ids,'settings')},{label:'설정 및 콘텐츠를 복제한 새로운 트랙',shortcut:shortcutLabel('duplicateTrackContent'),onSelect:()=>onDuplicateTracks(ids,'content')},{type:'separator'},{label:'트랙 색상 지정…',shortcut:shortcutLabel('colorPalette'),onSelect:()=>{if(menu)onColorPalette(ids,{x:menu.x,y:menu.y})}},{type:'separator'},{label:'트랙 삭제',shortcut:shortcutLabel('deleteTrack'),danger:true,onSelect:()=>onDeleteTracks(ids)}]}
  const menuTrack=menu&&project.tracks.find(t=>t.id===menu.id)
  // ChannelStrip passes its click event to onSelect even though the prop is typed without one.
  const select=(id:string)=>(e?:React.MouseEvent)=>onTrackClick(id,{range:!!e?.shiftKey,toggle:!!(e&&(e.metaKey||e.ctrlKey)),trackOnly:!!e?.altKey})
  return <div className="mixer" ref={rootRef} data-keyboard-scope="mixer" tabIndex={-1} aria-label="믹서" style={{'--ch-w':`${width}px`,'--fader-h':`${fader}px`} as React.CSSProperties} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href],[tabindex]'))e.currentTarget.focus({preventScroll:true})}}>
    <div className="mixer-channels" ref={channelsRef}>{project.tracks.map(track=><div key={track.id} className={`mixer-channel ${selectedTrackIds.has(track.id)?'selected':''} ${track.hidden?'hidden-track':''}`} data-track-id={track.id} onContextMenu={e=>{e.preventDefault();setMenu({id:track.id,x:e.clientX,y:e.clientY})}}>
      <ChannelStrip {...strip} track={track} project={project} engine={engine} recording={recording} compact arm={effectiveArm(track,focusedTrackId,project.tracks)} implicitMute={implicitlyMuted(track,project)} focused={track.id===focusedTrackId} onSelect={select(track.id)}/>
      {editingId===track.id&&<input className="channel-rename" autoFocus defaultValue={track.name} aria-label={`${track.name} 이름 바꾸기`} onClick={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()} onContextMenu={e=>e.stopPropagation()} onFocus={e=>e.currentTarget.select()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finishRename(track,e.currentTarget.value)}else if(e.key==='Escape'){e.preventDefault();finishRename(track,null)}}} onBlur={e=>finishRename(track,e.currentTarget.value)}/>}
    </div>)}</div>
    <div className="mixer-master"><ChannelStrip track={undefined} project={project} engine={engine} recording={recording} compact arm="off" implicitMute={false} onTrackChange={strip.onTrackChange} onTrackButton={strip.onTrackButton} onTrackSweep={strip.onTrackSweep} onMasterChange={strip.onMasterChange}/></div>
    {menu&&menuTrack&&<ContextMenu x={menu.x} y={menu.y} items={menuItems(menuTrack)} onClose={()=>setMenu(null)} label={`${menuTrack.name} 채널 메뉴`}/>}
  </div>
}
