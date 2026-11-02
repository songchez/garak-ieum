import { memo, useId, useRef, useState } from 'react'
import type { AudioAsset, Clip, Track } from '../core/types'
import { instrumentDef } from '../core/instruments'
import { clipOccurrences, isTrackEnabled } from '../core/playback'
import { regionDisplayName } from '../core/regionDisplay'
import { isShortcutSuppressed, isUnmodified } from '../core/input'
import { contrastTextColor } from '../core/colors'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import './TimelineClip.css'

export type GestureMode = 'move'|'trimStart'|'trimEnd'
export type Preview = {start:number;length:number;dy:number;clip?:Clip;trackId?:string}
export type ClipActions = {
  beginClipGesture:(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip,mode:GestureMode,captureTarget?:HTMLElement|null)=>void
  clipMenu:(e:React.MouseEvent,track:Track,clip:Clip)=>void
  select:(trackId:string,clipId:string)=>void
  open:(trackId:string,clipId:string)=>void
  renameDone:(clipId:string,name:string|null)=>void
  loopHandle:(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip)=>void
}

/** Fades are only drawn once a beat is wide enough for the waveform to read (V-08). */
export const FADE_MIN_PPB = 20

// Focus that comes from a pointer gesture must not re-run keyboard-focus selection.
let focusFromPointer=false
export function pointerFocus(el:HTMLElement){focusFromPointer=true;try{el.focus({preventScroll:true})}finally{focusFromPointer=false}}

export function InlineName({value,label,onDone}:{value:string;label:string;onDone:(name:string|null)=>void}){
  const [draft,setDraft]=useState(value)
  const done=useRef(false)
  const finish=(name:string|null)=>{if(done.current)return;done.current=true;const trimmed=name?.trim();onDone(trimmed&&trimmed!==value?name!.slice(0,512):null)}
  return <input className="inline-name" aria-label={label} value={draft} autoFocus onFocus={e=>e.currentTarget.select()} onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>e.stopPropagation()} onChange={e=>setDraft(e.target.value)} onBlur={()=>finish(draft)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();finish(draft)}else if(e.key==='Escape'){e.preventDefault();finish(null)}}}/>
}

export interface TimelineClipProps {
  clip:Clip; track:Track; asset?:AudioAsset; ppb:number; bpm:number; projectEnd:number
  selected:boolean; preview?:Preview; renaming:boolean; actions:React.RefObject<ClipActions>
  occurrenceTrack?:Track; silent?:boolean
}

/**
 * One region plus its loop repeats (Logic §5): muted = gray body with a dot before the name, looped = shaded
 * ghost repeats with notches, transposed MIDI = "(+N)" suffix, audio fades as triangles when zoomed in.
 */
export const TimelineClip=memo(function TimelineClip({clip,track,asset,ppb,bpm,projectEnd,selected,preview,renaming,actions,occurrenceTrack=track,silent=false}:TimelineClipProps){
  const regionRef=useRef<HTMLDivElement>(null)
  const notePreviewId=useId()
  const onSelect=(trackId:string,clipId:string)=>actions.current.select(trackId,clipId)
  const displayClip=preview?{...(preview.clip??clip),startBeat:preview.start,lengthBeats:preview.length}:clip
  const notes=displayClip.kind==='midi'?displayClip.notes:[]
  const min=notes.length?Math.min(...notes.map(n=>n.pitch)):48,max=notes.length?Math.max(...notes.map(n=>n.pitch)):72
  const start=displayClip.startBeat,length=displayClip.lengthBeats,dy=preview?.dy??0
  const repeats=displayClip.loop?clipOccurrences(occurrenceTrack,displayClip,projectEnd).slice(1):[]
  const widthPx=Math.max(3,length*ppb-2)
  const fades=displayClip.kind==='audio'&&ppb>=FADE_MIN_PPB&&(displayClip.fadeIn>0||displayClip.fadeOut>0)?{inPx:Math.min(widthPx,displayClip.fadeIn*bpm/60*ppb),outPx:Math.min(widthPx,displayClip.fadeOut*bpm/60*ppb)}:null
  const cls=['timeline-clip',clip.kind]
  if(selected)cls.push('clip-selected');if(preview)cls.push('clip-moving');if(clip.mute)cls.push('clip-muted');if(clip.loop)cls.push('clip-looped')
  const label=regionDisplayName(displayClip)
  // Ancestor state changes also invalidate the canvas, whose color follows the same CSS as MIDI previews.
  const waveformAppearance=`${selected}:${!!clip.mute}:${silent}:${isTrackEnabled(track)}:${track.color}`
  const contents=(repeat=false)=><>
    <div className="clip-title"><Icon name={clip.kind==='audio'?'wave':'note'} size={11}/>{clip.mute&&<i className="clip-mute-dot" aria-hidden="true"/>}{!repeat&&renaming?<InlineName value={clip.name} label="클립 이름" onDone={name=>actions.current.renameDone(clip.id,name)}/>:<span>{label}</span>}</div>
    <div className="clip-preview">{clip.kind==='audio'&&asset?<Waveform peaks={asset.peaks} color={repeat?'var(--loop-preview)':'var(--clip-preview-color)'} appearanceKey={waveformAppearance}/>:<svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(.01,length)*20} 32`} aria-hidden="true">{repeat?<use href={`#${notePreviewId}`}/>:<g id={notePreviewId}>{notes.filter(n=>n.start<length).map(n=><rect key={n.id} x={n.start*20} y={3+(1-(n.pitch-min)/Math.max(12,max-min))*23} width={Math.max(1,Math.min(n.duration,length-n.start)*20-1)} height={instrumentDef(track.instrument).isKit?4:2.5} rx=".7" fill="currentColor" opacity={.45+n.velocity*.5}/>)}</g>}</svg>}</div>
    {fades&&<svg className="clip-fades" aria-hidden="true" width={widthPx} height="100%" viewBox={`0 0 ${widthPx} 100`} preserveAspectRatio="none">{fades.inPx>0&&<polygon points={`0,0 ${fades.inPx},0 0,100`}/>}{fades.outPx>0&&<polygon points={`${widthPx-fades.outPx},0 ${widthPx},0 ${widthPx},100`}/>}</svg>}
  </>
  return <>
    <div ref={regionRef} className={cls.join(' ')} tabIndex={0} role="button" aria-pressed={selected} aria-label={`${label}, ${clip.startBeat/4+1} 마디${clip.mute?', 뮤트됨':''}${clip.loop?', 루프':''}`} onFocus={()=>{if(!focusFromPointer&&!selected)onSelect(track.id,clip.id)}} onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'move')} onDoubleClick={e=>{if(!(e.target as Element).closest('input,.clip-loop-handle'))actions.current.open(track.id,clip.id)}} onContextMenu={e=>actions.current.clipMenu(e,track,clip)} onKeyDown={e=>{if(e.key==='Enter'&&isUnmodified(e.nativeEvent)&&!isShortcutSuppressed(e.nativeEvent,true)){e.preventDefault();e.stopPropagation();if(!e.repeat)onSelect(track.id,clip.id)}}} style={{left:start*ppb,width:widthPx,transform:dy?`translateY(${dy}px)`:undefined,'--clip-color':track.color,'--clip-selected-text':contrastTextColor(track.color,.2)} as React.CSSProperties}>
      {contents()}
      <div className="clip-resize-left" title="드래그하여 시작 지점 자르기" onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'trimStart')}/>
      <div className="clip-resize" title="드래그하여 클립 길이 조절" onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'trimEnd')}/>
      <div className="clip-loop-handle" title={clip.loop?'루프 끄기':'루프 (클릭 또는 오른쪽으로 드래그)'} onPointerDown={e=>actions.current.loopHandle(e,track,clip)}>{clip.loop&&<Icon name="loop" size={9}/>}</div>
    </div>
    {repeats.map(occ=><div key={`${clip.id}-loop-${occ.index}`} className={`clip-loop-ghost ${clip.kind}${selected?' clip-selected':''}${clip.mute?' clip-muted':''}${preview?' clip-moving':''}`} aria-hidden="true" title={`${label} · 루프 ${occ.index+1}회`} onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'move',regionRef.current)} onDoubleClick={()=>actions.current.open(track.id,clip.id)} onContextMenu={e=>actions.current.clipMenu(e,track,clip)} style={{left:occ.start*ppb,width:Math.max(2,(occ.end-occ.start)*ppb-2),transform:dy?`translateY(${dy}px)`:undefined,'--clip-color':track.color} as React.CSSProperties}>
      <div className="clip-loop-content" style={{width:Math.max(1,widthPx-2)}}>{contents(true)}</div><i className="clip-loop-notch top"/><i className="clip-loop-notch bottom"/>
    </div>)}
  </>
})
