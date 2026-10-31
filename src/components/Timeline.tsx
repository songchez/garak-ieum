import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AudioAsset, AudioEngine, Clip, Project, Track } from '../core/types'
import { categoryIcon, instrumentDef } from '../core/instruments'
import { MIN_CLIP_BEATS, trimClipStart } from '../core/project'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { crossedDragThreshold, dragModifiers, isShortcutSuppressed, isUnmodified, shortcutLabel, shortcutPlatform, snapDragDelta, type ProjectShortcut } from '../core/input'
import { ZOOM_LIMITS, zoomAround, zoomBy } from '../core/zoom'
import { useZoomWheel } from './useZoomWheel'
import { ZoomControls } from './ZoomControls'

export const HEADER_WIDTH = 208
export const MIN_PPB = ZOOM_LIMITS.timelineX.min, MAX_PPB = ZOOM_LIMITS.timelineX.max
const RULER_HEIGHT = 38
export const TRACK_COLORS = [['#6f9fd0','하늘'],['#7fb59a','숲'],['#e38457','노을'],['#8cc7c0','물빛'],['#d98a9f','꽃잎'],['#d9b45a','황금']] as const
const CYCLE_BAND = 16
const EDGE = 24, EDGE_STEP = 10

export type ClipEdit = {mode:'move';ids:string[];dBeat:number;dRow:number;copy:boolean}|{mode:'trimStart'|'trimEnd';ids:string[];dBeat:number}
export type RenameTarget = {kind:'track'|'clip';id:string}
type GestureMode = 'move'|'trimStart'|'trimEnd'
type DragState = {mode:GestureMode;ids:Set<string>;dBeat:number;dRow:number;copy:boolean;rowTops:number[]}
type Preview = {start:number;length:number;dy:number}
type MenuState = {x:number;y:number;items:ContextMenuItem[];label:string}

interface Props {
  project: Project; assets: Map<string,AudioAsset>; engine: AudioEngine
  selectedTrackId:string; selectedClipIds:ReadonlySet<string>; pixelsPerBeat:number; rowHeight:number; snap:number
  renaming:RenameTarget|null
  onRenaming:(target:RenameTarget|null)=>void
  onSelect:(trackId:string,clipId?:string,opts?:{add?:boolean;toggle?:boolean})=>void
  onSelectClips:(ids:string[],add:boolean)=>void
  onTrackSelect:(trackId:string)=>void
  onTrackOpen:(trackId:string)=>void
  onClipOpen:(trackId:string,clipId:string)=>void
  onTrackChange:(id:string,patch:Partial<Track>)=>void
  onTrackAction:(id:string,action:'duplicate'|'delete'|'up'|'down')=>void
  onTrackMove:(id:string,toIndex:number)=>void
  onClipRename:(clipId:string,name:string)=>void
  onClipsEdit:(edit:ClipEdit)=>void
  onLoopChange:(start:number,end:number,enabled:boolean)=>void
  onZoom:(ppb:number)=>void
  onZoomY:(rowHeight:number)=>void
  onCommand:(command:ProjectShortcut,ctx?:{trackId?:string;beat?:number})=>void
  onAddClip:(trackId:string,beat:number)=>void
  onAudioDrop:(files:FileList,trackId?:string,beat?:number)=>void
  onAddTrack:()=>void
}

/** Scrolls the timeline while a gesture's pointer rests near an edge. */
function edgeScroller(scroll:HTMLElement,onScroll:()=>void){
  let x=0,y=0,armed=false,raf=0
  const tick=()=>{
    if(armed){const r=scroll.getBoundingClientRect();const dx=x<r.left+HEADER_WIDTH+EDGE?-EDGE_STEP:x>r.right-EDGE?EDGE_STEP:0;const dy=y<r.top+38+EDGE?-EDGE_STEP:y>r.bottom-EDGE?EDGE_STEP:0
      if(dx||dy){const left=scroll.scrollLeft,top=scroll.scrollTop;scroll.scrollLeft+=dx;scroll.scrollTop+=dy;if(scroll.scrollLeft!==left||scroll.scrollTop!==top)onScroll()}}
    raf=requestAnimationFrame(tick)
  }
  raf=requestAnimationFrame(tick)
  return{update(cx:number,cy:number){x=cx;y=cy;armed=true},stop(){cancelAnimationFrame(raf)}}
}

/** Shared cleanup for window-level pointer gestures: Escape, blur, hidden page and lost capture cancel. */
function trackPointer(target:HTMLElement,pointerId:number,kind:string,handlers:{move:(e:PointerEvent)=>void;end:(commit:boolean,e?:PointerEvent)=>void}){
  let active=true
  const finish=(commit:boolean,event?:PointerEvent)=>{
    if(!active)return
    active=false
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up)
    window.removeEventListener('pointercancel',cancelPointer);window.removeEventListener('blur',cancel)
    window.removeEventListener('keydown',key,true);document.removeEventListener('visibilitychange',visibility)
    target.removeEventListener('lostpointercapture',cancelPointer);delete target.dataset.dawGesture
    if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId)
    handlers.end(commit,event)
  }
  const move=(event:PointerEvent)=>{if(active&&event.pointerId===pointerId)handlers.move(event)}
  const up=(event:PointerEvent)=>{if(event.pointerId!==pointerId)return;handlers.move(event);finish(true,event)}
  const cancel=()=>finish(false)
  const cancelPointer=(event:PointerEvent)=>{if(event.pointerId===pointerId)finish(false)}
  const visibility=()=>{if(document.hidden)finish(false)}
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&isUnmodified(event)&&!isShortcutSuppressed(event)){event.preventDefault();event.stopPropagation();finish(false)}}
  target.dataset.dawGesture=kind
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up)
  window.addEventListener('pointercancel',cancelPointer);window.addEventListener('blur',cancel)
  window.addEventListener('keydown',key,true);document.addEventListener('visibilitychange',visibility)
  target.addEventListener('lostpointercapture',cancelPointer)
  try{target.setPointerCapture(pointerId)}catch{/* Blur/cancel listeners remain a fallback if capture is unavailable. */}
  return()=>finish(false)
}

const snapMode=(e:{altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean})=>{const m=dragModifiers(e);return m.noSnap?'none' as const:m.fine?'fine' as const:'snap' as const}
const fineStep=(snap:number)=>snap>0?Math.min(snap/2,.125):.125
const isToggleClick=(e:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean})=>e.shiftKey||(shortcutPlatform()==='mac'?e.metaKey:e.ctrlKey)

export function Timeline(props:Props){
  const {project,assets,engine,selectedTrackId,selectedClipIds,pixelsPerBeat:ppb,snap,renaming}=props
  const rowHeight=Math.round(props.rowHeight)
  const scrollRef=useRef<HTMLDivElement>(null)
  const sheetRef=useRef<HTMLDivElement>(null)
  const rulerRef=useRef<HTMLDivElement>(null)
  const latest=useRef(props);latest.current=props
  const [fileOver,setFileOver]=useState(false)
  const [drag,setDrag]=useState<DragState|null>(null)
  const [marquee,setMarquee]=useState<{x:number;y:number;w:number;h:number;ids:Set<string>;add:boolean}|null>(null)
  const [loopDraft,setLoopDraft]=useState<{start:number;end:number}|null>(null)
  const [trackDrop,setTrackDrop]=useState<{id:string;index:number;y:number}|null>(null)
  const [menu,setMenu]=useState<MenuState|null>(null)
  const [follow,setFollow]=useState(true)
  const followRef=useRef(follow);followRef.current=follow
  const cancelGesture=useRef<(()=>void)|null>(null)
  const zoomAnchor=useRef<{beat:number;px:number}|null>(null)
  const prevPpb=useRef(ppb)
  const rowAnchor=useRef<number|null>(null)
  const prevRow=useRef(rowHeight)
  useEffect(()=>()=>cancelGesture.current?.(),[])

  const contentEnd=Math.max(project.lengthBeats,...project.tracks.flatMap(t=>t.clips.map(c=>c.startBeat+c.lengthBeats)))
  const width=(contentEnd+8)*ppb
  const trackIndex=new Map(project.tracks.map((t,i)=>[t.id,i]))
  const clipTrack=new Map(project.tracks.flatMap(t=>t.clips.map(c=>[c.id,t] as const)))
  const sheetPoint=(clientX:number,clientY:number)=>{const r=sheetRef.current!.getBoundingClientRect();return{x:clientX-r.left,y:clientY-r.top}}
  const rowTops=()=>Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(':scope > .track-row')??[]).map(row=>row.offsetTop)
  const rowAt=(tops:number[],y:number)=>{let index=0;for(let i=0;i<tops.length;i++)if(y>=tops[i])index=i;return index}

  // Ctrl/⌘ + wheel zooms time, Ctrl/⌘ + Shift (or Alt) + wheel zooms track height, both around the pointer.
  useZoomWheel(scrollRef,{
    onZoomX:(factor,x)=>{
      const scroll=scrollRef.current!,current=latest.current.pixelsPerBeat,px=Math.max(HEADER_WIDTH,x)
      const next=zoomBy(current,factor,ZOOM_LIMITS.timelineX)
      if(Math.abs(next-current)<.01)return
      zoomAnchor.current={beat:(scroll.scrollLeft+px-HEADER_WIDTH)/current,px}
      latest.current.onZoom(next)
    },
    onZoomY:(factor,y)=>{
      const current=latest.current.rowHeight,next=zoomBy(current,factor,ZOOM_LIMITS.timelineY)
      if(Math.abs(next-current)<.01)return
      rowAnchor.current=Math.max(RULER_HEIGHT,y)
      latest.current.onZoomY(next)
    },
  })
  // Track height zoom keeps the row under the pointer (or the top visible row) in place.
  useLayoutEffect(()=>{
    const previous=prevRow.current;prevRow.current=rowHeight
    const scroll=scrollRef.current,py=rowAnchor.current??RULER_HEIGHT;rowAnchor.current=null
    if(!scroll||previous===rowHeight)return
    scroll.scrollTop=zoomAround(scroll.scrollTop,py-RULER_HEIGHT,previous,rowHeight)
  })
  // Keep the zoom anchor fixed: the pointer for wheel zoom, otherwise a visible playhead or the left edge.
  useLayoutEffect(()=>{
    const previous=prevPpb.current;prevPpb.current=ppb
    const scroll=scrollRef.current;if(!scroll||previous===ppb)return
    let anchor=zoomAnchor.current;zoomAnchor.current=null
    if(!anchor){const beat=engine.getSnapshot().beat,px=beat*previous+HEADER_WIDTH-scroll.scrollLeft;anchor=px>=HEADER_WIDTH&&px<=scroll.clientWidth?{beat,px}:{beat:scroll.scrollLeft/previous,px:HEADER_WIDTH}}
    scroll.scrollLeft=Math.max(0,anchor.beat*ppb+HEADER_WIDTH-anchor.px)
  },[ppb,engine])

  function openMenu(e:React.MouseEvent,items:ContextMenuItem[],label:string){e.preventDefault();e.stopPropagation();cancelGesture.current?.();setMenu({x:e.clientX,y:e.clientY,items,label})}
  const item=(label:string,command:ProjectShortcut,extra:Partial<Extract<ContextMenuItem,{label:string}>>={},ctx?:{trackId?:string;beat?:number}):ContextMenuItem=>({label,shortcut:shortcutLabel(command)||undefined,onSelect:()=>latest.current.onCommand(command,ctx),...extra})

  function clipMenu(e:React.MouseEvent,track:Track,clip:Clip){
    const selected=selectedClipIds.has(clip.id)
    if(!selected)props.onSelect(track.id,clip.id)
    const count=selected?selectedClipIds.size:1
    const muted=clip.mute
    openMenu(e,[item('잘라내기','cut'),item('복사','copy'),item('붙여넣기','paste'),{type:'separator'},item('복제','duplicate'),item('반복','repeat'),item('재생 위치에서 분할','split'),item('합치기','join',{disabled:count<2}),{type:'separator'},item(muted?'뮤트 해제':'뮤트','muteClip'),item('이름 바꾸기','renameClip'),{type:'separator'},item(count>1?`클립 ${count}개 삭제`:'삭제','deleteClip',{danger:true})],'클립 메뉴')
  }
  function trackMenu(e:React.MouseEvent,track:Track,index:number){
    props.onSelect(track.id)
    openMenu(e,[{label:'이름 바꾸기',shortcut:shortcutLabel('renameTrack')||undefined,onSelect:()=>latest.current.onRenaming({kind:'track',id:track.id})},{label:'색상',items:TRACK_COLORS.map(([color,name])=>({label:name,checked:track.color===color,onSelect:()=>latest.current.onTrackChange(track.id,{color})}))},{label:'트랙 복제',onSelect:()=>latest.current.onTrackAction(track.id,'duplicate')},{type:'separator'},{label:'위로 이동',disabled:index===0,onSelect:()=>latest.current.onTrackAction(track.id,'up')},{label:'아래로 이동',disabled:index===project.tracks.length-1,onSelect:()=>latest.current.onTrackAction(track.id,'down')},{type:'separator'},{label:'디바이스 열기',onSelect:()=>latest.current.onTrackOpen(track.id)},{label:'트랙 삭제…',shortcut:shortcutLabel('deleteTrack')||undefined,danger:true,onSelect:()=>latest.current.onTrackAction(track.id,'delete')}],'트랙 메뉴')
  }
  function laneMenu(e:React.MouseEvent,track:Track){
    const beat=Math.max(0,(e.clientX-e.currentTarget.getBoundingClientRect().left)/ppb)
    const at=snap>0?Math.round(beat/snap)*snap:beat,bar=Math.floor(beat/4)*4
    props.onSelect(track.id)
    openMenu(e,[item('여기에 붙여넣기','paste',{},{trackId:track.id,beat:at}),{type:'separator'},track.kind==='audio'?{label:'오디오 가져오기…',onSelect:()=>latest.current.onAddClip(track.id,bar)}:{label:'MIDI 클립 만들기',onSelect:()=>latest.current.onAddClip(track.id,bar)}],'레인 메뉴')
  }

  /** Move or trim every selected clip together. The grabbed clip decides the row origin. */
  function beginClipGesture(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip,mode:GestureMode){
    if(e.button!==0)return
    // macOS Ctrl-click is the secondary click; the contextmenu event follows.
    if(shortcutPlatform()==='mac'&&e.ctrlKey)return
    e.stopPropagation();e.preventDefault();cancelGesture.current?.()
    const target=e.currentTarget.closest<HTMLElement>('.timeline-clip')??e.currentTarget
    const scroll=scrollRef.current,sheet=sheetRef.current;if(!scroll||!sheet)return
    const wasSelected=selectedClipIds.has(clip.id),toggle=isToggleClick(e)
    let ids:Set<string>
    if(!wasSelected){ids=toggle?new Set([...selectedClipIds,clip.id]):new Set([clip.id]);props.onSelect(track.id,clip.id,{add:toggle})}
    else ids=new Set([...selectedClipIds].filter(id=>clipTrack.has(id)))
    pointerFocus(target)
    const tops=rowTops(),originRow=trackIndex.get(track.id)??0
    const origin={x:e.clientX,y:e.clientY,left:scroll.scrollLeft,top:scroll.scrollTop}
    const group=[...ids].map(id=>{const t=clipTrack.get(id)!;return{clip:t.clips.find(c=>c.id===id)!,row:trackIndex.get(t.id)!,kind:t.kind}})
    const minStart=Math.min(...group.map(g=>g.clip.startBeat))
    let state:DragState={mode,ids,dBeat:0,dRow:0,copy:false,rowTops:tops},started=false,last:PointerEvent|null=null
    const validRow=(d:number)=>group.every(g=>{const t=project.tracks[g.row+d];return!!t&&t.kind===g.kind})
    const compute=(event:PointerEvent)=>{
      last=event
      const dx=event.clientX-origin.x+scroll.scrollLeft-origin.left,dy=event.clientY-origin.y+scroll.scrollTop-origin.top
      if(!started&&!crossedDragThreshold(dx,dy))return
      if(!started){started=true;sheet.closest('.arrangement')?.classList.add('clip-gesture')}
      scroller.update(event.clientX,event.clientY)
      const mods=dragModifiers(event)
      let dBeat=snapDragDelta(dx/ppb,snap,snapMode(event),fineStep(snap)),dRow=0
      if(mode==='move'){
        const pointerRow=rowAt(tops,sheetPoint(event.clientX,event.clientY).y)
        dRow=pointerRow-originRow
        if(mods.axisLock){if(Math.abs(dx)>=Math.abs(dy))dRow=0;else dBeat=0}
        while(dRow!==0&&!validRow(dRow))dRow+=dRow>0?-1:1
        dBeat=Math.max(-minStart,dBeat)
      }
      state={mode,ids,dBeat,dRow,copy:mode==='move'&&mods.copy,rowTops:tops}
      setDrag(state)
    }
    const scroller=edgeScroller(scroll,()=>{if(last)compute(last)})
    const stop=trackPointer(target,e.pointerId,mode==='move'?'move':'resize',{move:compute,end:(commit,event)=>{
      scroller.stop();cancelGesture.current=null;setDrag(null);sheet.closest('.arrangement')?.classList.remove('clip-gesture')
      if(!commit)return
      if(!started){
        // A click without movement: modifier toggles a selected clip off, a plain click narrows to it.
        if(wasSelected)props.onSelect(track.id,clip.id,toggle?{toggle:true}:{})
        return
      }
      if(event&&mode==='move')state={...state,copy:dragModifiers(event).copy}
      if(Math.abs(state.dBeat)<1e-9&&state.dRow===0&&!state.copy)return
      latest.current.onClipsEdit(mode==='move'?{mode,ids:[...ids],dBeat:state.dBeat,dRow:state.dRow,copy:state.copy}:{mode,ids:[...ids],dBeat:state.dBeat})
    }})
    cancelGesture.current=stop
  }

  /** Rubber-band selection across tracks and time, started on an empty lane. */
  function beginMarquee(e:React.PointerEvent<HTMLElement>,track:Track){
    if(e.button!==0||e.target!==e.currentTarget)return
    const scroll=scrollRef.current,sheet=sheetRef.current;if(!scroll||!sheet)return
    cancelGesture.current?.()
    const start=sheetPoint(e.clientX,e.clientY),tops=rowTops(),add=e.shiftKey
    const heights=tops.map((top,i)=>(tops[i+1]??top+(sheet.querySelector<HTMLElement>(':scope > .track-row')?.offsetHeight??70))-top)
    let started=false,last:PointerEvent|null=null,ids=new Set<string>()
    const compute=(event:PointerEvent)=>{
      last=event
      const p=sheetPoint(event.clientX,event.clientY)
      if(!started&&!crossedDragThreshold(p.x-start.x,p.y-start.y))return
      started=true;scroller.update(event.clientX,event.clientY)
      const x0=Math.min(start.x,p.x),x1=Math.max(start.x,p.x),y0=Math.min(start.y,p.y),y1=Math.max(start.y,p.y)
      const b0=(x0-HEADER_WIDTH)/ppb,b1=(x1-HEADER_WIDTH)/ppb
      ids=new Set(project.tracks.flatMap((t,i)=>tops[i]<y1&&tops[i]+heights[i]>y0?t.clips.filter(c=>c.startBeat<b1&&c.startBeat+c.lengthBeats>b0).map(c=>c.id):[]))
      setMarquee({x:Math.max(HEADER_WIDTH,x0),y:y0,w:x1-Math.max(HEADER_WIDTH,x0),h:y1-y0,ids,add})
    }
    const scroller=edgeScroller(scroll,()=>{if(last)compute(last)})
    cancelGesture.current=trackPointer(e.currentTarget,e.pointerId,'marquee',{move:compute,end:commit=>{
      scroller.stop();cancelGesture.current=null;setMarquee(null)
      if(!commit)return
      if(started)latest.current.onSelectClips([...ids],add)
      else latest.current.onSelect(track.id,undefined,{add})
    }})
  }

  /** Top band: create, move or resize the cycle range (bar snap, Shift = beat snap); a click toggles it. Lower band: seek/scrub. */
  function beginRuler(e:React.PointerEvent<HTMLDivElement>){
    if(e.button!==0)return
    const ruler=e.currentTarget,rect=ruler.getBoundingClientRect(),y=e.clientY-rect.top
    const beatAt=(clientX:number)=>Math.max(0,(clientX-ruler.getBoundingClientRect().left)/ppb)
    const scroll=scrollRef.current!
    cancelGesture.current?.()
    if(y>=CYCLE_BAND){
      const seek=(event:{clientX:number;shiftKey:boolean})=>{let beat=beatAt(event.clientX);if(snap>0&&!event.shiftKey)beat=Math.round(beat/snap)*snap;engine.seek(Math.min(latest.current.project.lengthBeats,beat))}
      seek(e)
      cancelGesture.current=trackPointer(ruler,e.pointerId,'seek',{move:seek,end:()=>{cancelGesture.current=null}})
      return
    }
    const loop=project.loop,down=beatAt(e.clientX),x=down*ppb
    const kind=Math.abs(x-loop.startBeat*ppb)<=6?'start':Math.abs(x-loop.endBeat*ppb)<=6?'end':down>loop.startBeat&&down<loop.endBeat?'move':'create'
    let started=false,draft={start:loop.startBeat,end:loop.endBeat},last:PointerEvent|null=null
    const compute=(event:PointerEvent)=>{
      last=event
      if(!started&&!crossedDragThreshold(event.clientX-e.clientX))return
      started=true;const box=scroll.getBoundingClientRect();scroller.update(event.clientX,box.top+box.height/2)
      const unit=event.shiftKey?(snap||.25):4,q=(b:number)=>Math.max(0,Math.round(b/unit)*unit),beat=beatAt(event.clientX)
      if(kind==='move'){const d=q(beat-down);const len=loop.endBeat-loop.startBeat;const start=Math.max(0,loop.startBeat+d);draft={start,end:start+len}}
      else if(kind==='start')draft={start:Math.min(q(beat),loop.endBeat-unit),end:loop.endBeat}
      else if(kind==='end')draft={start:loop.startBeat,end:Math.max(q(beat),loop.startBeat+unit)}
      else{const a=Math.floor(down/unit)*unit,b=q(beat);draft=b>a?{start:a,end:Math.max(b,a+unit)}:{start:Math.min(b,a),end:a+unit}}
      setLoopDraft(draft)
    }
    const scroller=edgeScroller(scroll,()=>{if(last)compute(last)})
    cancelGesture.current=trackPointer(ruler,e.pointerId,'cycle',{move:compute,end:commit=>{
      scroller.stop();cancelGesture.current=null;setLoopDraft(null)
      if(!commit)return
      if(started)latest.current.onLoopChange(draft.start,draft.end,true)
      else if(kind!=='create')latest.current.onLoopChange(loop.startBeat,loop.endBeat,!loop.enabled)
      else{const a=Math.floor(down/4)*4;latest.current.onLoopChange(a,a+4,true)}
    }})
  }
  function rulerHover(e:React.PointerEvent<HTMLDivElement>){
    if(e.buttons)return
    const r=e.currentTarget.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,loop=project.loop
    e.currentTarget.style.cursor=y>=CYCLE_BAND?'':Math.abs(x-loop.startBeat*ppb)<=6||Math.abs(x-loop.endBeat*ppb)<=6?'ew-resize':x>loop.startBeat*ppb&&x<loop.endBeat*ppb?'grab':'pointer'
  }

  /** Track reorder by dragging the track number. */
  function beginTrackDrag(e:React.PointerEvent<HTMLElement>,track:Track){
    if(e.button!==0)return
    e.stopPropagation();e.preventDefault();cancelGesture.current?.()
    const tops=rowTops(),from=trackIndex.get(track.id)??0,origin=e.clientY,sheet=sheetRef.current!
    const rowHeight=sheet.querySelector<HTMLElement>(':scope > .track-row')?.offsetHeight??70
    let started=false,index=from
    const compute=(event:PointerEvent)=>{
      if(!started&&!crossedDragThreshold(0,event.clientY-origin))return
      started=true
      const y=sheetPoint(event.clientX,event.clientY).y
      index=tops.findIndex(top=>y<top+rowHeight/2);if(index<0)index=tops.length
      setTrackDrop({id:track.id,index,y:index<tops.length?tops[index]:tops[tops.length-1]+rowHeight})
    }
    cancelGesture.current=trackPointer(e.currentTarget,e.pointerId,'reorder',{move:compute,end:commit=>{
      cancelGesture.current=null;setTrackDrop(null)
      if(!commit)return
      if(!started)return
      const to=index>from?index-1:index
      if(to!==from)latest.current.onTrackMove(track.id,to)
    }})
  }

  function previewFor(track:Track,clip:Clip):Preview|undefined{
    if(!drag||!drag.ids.has(clip.id))return undefined
    if(drag.mode==='move'){const row=trackIndex.get(track.id)!;return{start:clip.startBeat+drag.dBeat,length:clip.lengthBeats,dy:(drag.rowTops[row+drag.dRow]??0)-(drag.rowTops[row]??0)}}
    if(drag.mode==='trimEnd'){const asset=clip.kind==='audio'?assets.get(clip.assetId):undefined;const max=asset&&clip.kind==='audio'?Math.max(MIN_CLIP_BEATS,(asset.buffer.duration-clip.offsetSeconds)*project.bpm/60):Infinity;return{start:clip.startBeat,length:Math.min(max,Math.max(MIN_CLIP_BEATS,clip.lengthBeats+drag.dBeat)),dy:0}}
    const trimmed=trimClipStart(clip,clip.startBeat+drag.dBeat,project.bpm);return{start:trimmed.startBeat,length:trimmed.lengthBeats,dy:0}
  }
  const clipActions:ClipActions={beginClipGesture,clipMenu,select:(trackId,clipId)=>props.onSelect(trackId,clipId),open:props.onClipOpen,renameDone:(clipId,name)=>{props.onRenaming(null);if(name!==null)props.onClipRename(clipId,name)}}
  const actions=useRef(clipActions);actions.current=clipActions
  const loopView=loopDraft?{startBeat:loopDraft.start,endBeat:loopDraft.end}:project.loop
  const barPx=ppb*4,labelStep=barPx>=40?1:barPx>=20?2:barPx>=10?4:8
  const laneGrid=ppb<8?`${ppb*16}px 100%, ${ppb*4}px 100%`:`${ppb*4}px 100%, ${ppb}px 100%`

  return <div className={`arrangement ${fileOver?'file-over':''}`} data-keyboard-scope="timeline" tabIndex={-1} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href]'))e.currentTarget.focus({preventScroll:true})}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setFileOver(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setFileOver(false)}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();setFileOver(false);props.onAudioDrop(e.dataTransfer.files)}}}>
    <div className="arrangement-title"><div><span className="eyebrow">WORKSPACE</span><strong>어레인지먼트</strong><span className="subtle-count">{project.tracks.length} tracks{selectedClipIds.size>1?` · 클립 ${selectedClipIds.size}개 선택`:''}</span></div><div className="arrangement-title-actions"><span className="arrangement-hint">파일을 드래그해 새로운 소리를 더하세요 <Icon name="upload" size={14}/></span><ZoomControls area="어레인지먼트" onZoom={command=>latest.current.onCommand(command)}/><button className={`icon-button small follow-toggle ${follow?'active':''}`} aria-pressed={follow} onClick={e=>{setFollow(!follow);if(e.detail)e.currentTarget.blur()}} title="재생 위치 따라가기" aria-label="재생 위치 따라가기"><Icon name="right" size={14}/></button></div></div>
    <div className="timeline-scroll" ref={scrollRef}>
      <div className={`timeline-sheet ${rowHeight<48?'row-compact':rowHeight>=110?'row-large':''}`} ref={sheetRef} style={{width:width+HEADER_WIDTH,minWidth:'100%','--row-h':`${rowHeight}px`} as React.CSSProperties}>
        <div className="timeline-ruler-row">
          <div className="track-ruler-label">TRACKS <span>4/4</span></div>
          <div className="timeline-ruler" ref={rulerRef} style={{width}} onPointerDown={beginRuler} onPointerMove={rulerHover} title="위쪽 띠: 반복 구간 드래그·클릭 / 아래: 재생 위치 이동 (Shift = 스냅 무시)">
            {Array.from({length:Math.ceil(width/(ppb*4))},(_,i)=><div className="bar-number" key={i} style={{left:i*4*ppb,width:ppb*4}}>{i%labelStep===0?i+1:''}</div>)}
            <div className={`loop-region ${project.loop.enabled||loopDraft?'':'disabled'}`} style={{left:loopView.startBeat*ppb,width:(loopView.endBeat-loopView.startBeat)*ppb}}><span/><span/></div>
          </div>
        </div>
        {project.tracks.map((track,index)=><div className={`track-row ${selectedTrackId===track.id?'selected-track':''} ${trackDrop?.id===track.id?'track-dragging':''}`} key={track.id} style={{'--track-color':track.color} as React.CSSProperties}>
          <div className="track-header" onClick={e=>{if(!(e.target as Element).closest('button,input'))props.onTrackSelect(track.id)}} onDoubleClick={e=>{const el=e.target as Element;if(el.closest('button,input'))return;if(el.closest('.track-name'))props.onRenaming({kind:'track',id:track.id});else props.onTrackOpen(track.id)}} onContextMenu={e=>trackMenu(e,track,index)} title="클릭: 트랙 선택 · 더블 클릭: 디바이스 열기">
            <span className="track-number" title="드래그하여 트랙 순서 바꾸기" onPointerDown={e=>beginTrackDrag(e,track)}>{String(index+1).padStart(2,'0')}</span>
            <span className="track-symbol"><Icon name={track.kind==='audio'?'wave':categoryIcon(instrumentDef(track.instrument).category)} size={17}/>{track.kind==='instrument'&&<SampleDot engine={engine} setId={instrumentDef(track.instrument).set}/>}</span>
            <div className="track-heading">{renaming?.kind==='track'&&renaming.id===track.id?<InlineName value={track.name} label="트랙 이름" onDone={name=>{props.onRenaming(null);if(name!==null)props.onTrackChange(track.id,{name})}}/>:<span className="track-name" title={`${track.name} · 더블 클릭하여 이름 바꾸기`}>{track.name}</span>}<div className="track-controls"><button className={track.mute?'mute active':'mute'} title="뮤트" aria-label={`${track.name} 뮤트`} aria-pressed={track.mute} onClick={e=>{e.stopPropagation();props.onTrackChange(track.id,{mute:!track.mute});if(e.detail)e.currentTarget.blur()}}>M</button><button className={track.solo?'solo active':'solo'} title="솔로" aria-label={`${track.name} 솔로`} aria-pressed={track.solo} onClick={e=>{e.stopPropagation();props.onTrackChange(track.id,{solo:!track.solo});if(e.detail)e.currentTarget.blur()}}>S</button><button className="track-open" title="디바이스 열기" aria-label={`${track.name} 디바이스 열기`} onClick={e=>{e.stopPropagation();props.onTrackOpen(track.id);if(e.detail)e.currentTarget.blur()}}><Icon name="plug" size={10}/></button><span className="track-kind">{track.kind==='audio'?'AUDIO':'MIDI'}</span></div></div>
            <MiniMeter engine={engine} trackId={track.id} color={track.color}/>
          </div>
          <div className="track-lane" style={{width,backgroundSize:laneGrid}} onPointerDown={e=>beginMarquee(e,track)} onContextMenu={e=>{if(e.target===e.currentTarget)laneMenu(e,track)}} onDoubleClick={e=>{if(e.target!==e.currentTarget)return;props.onAddClip(track.id,Math.floor((e.clientX-e.currentTarget.getBoundingClientRect().left)/ppb/4)*4)}} onDragOver={e=>{if(e.dataTransfer.files||e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();setFileOver(false);const beat=Math.floor((e.clientX-e.currentTarget.getBoundingClientRect().left)/ppb/4)*4;props.onAudioDrop(e.dataTransfer.files,track.kind==='audio'?track.id:undefined,Math.max(0,beat))}}}>
            {drag?.copy&&track.clips.filter(c=>drag.ids.has(c.id)).map(c=><div key={`ghost-${c.id}`} className="clip-ghost" style={{left:c.startBeat*ppb,width:c.lengthBeats*ppb-2}}/>)}
            {track.clips.map(clip=><TimelineClip key={clip.id} clip={clip} track={track} asset={clip.kind==='audio'?assets.get(clip.assetId):undefined} ppb={ppb} selected={marquee?(marquee.ids.has(clip.id)||(marquee.add&&selectedClipIds.has(clip.id))):selectedClipIds.has(clip.id)} preview={previewFor(track,clip)} renaming={renaming?.kind==='clip'&&renaming.id===clip.id} actions={actions}/>)}
            {!track.clips.length&&<span className="empty-lane-hint">{track.kind==='audio'?'오디오 파일을 여기에 놓으세요':'더블 클릭하여 MIDI 클립 만들기'}</span>}
          </div>
        </div>)}
        <div className="add-track-row"><button onClick={props.onAddTrack}><Icon name="plus" size={15}/> 트랙 추가</button><div style={{width,backgroundSize:`${ppb*4}px 100%`}}/></div>
        {marquee&&<div className="marquee" style={{left:marquee.x,top:marquee.y,width:marquee.w,height:marquee.h}}/>}
        {trackDrop&&<div className="track-drop-indicator" style={{top:trackDrop.y-1}}/>}
        <Playhead engine={engine} ppb={ppb} scrollRef={scrollRef} followRef={followRef}/>
      </div>
    </div>
    {fileOver&&<div className="drop-overlay"><Icon name="wave" size={32}/><strong>오디오를 프로젝트에 추가합니다</strong><span>파일은 이 브라우저에 저장됩니다</span></div>}
    {menu&&<ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={()=>setMenu(null)}/>}
  </div>
}

// Focus that comes from a pointer gesture must not re-run keyboard-focus selection.
let focusFromPointer=false
function pointerFocus(el:HTMLElement){focusFromPointer=true;try{el.focus({preventScroll:true})}finally{focusFromPointer=false}}

function InlineName({value,label,onDone}:{value:string;label:string;onDone:(name:string|null)=>void}){
  const [draft,setDraft]=useState(value)
  const done=useRef(false)
  const finish=(name:string|null)=>{if(done.current)return;done.current=true;const trimmed=name?.trim();onDone(trimmed&&trimmed!==value?name!.slice(0,512):null)}
  return <input className="inline-name" aria-label={label} value={draft} autoFocus onFocus={e=>e.currentTarget.select()} onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onChange={e=>setDraft(e.target.value)} onBlur={()=>finish(draft)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();finish(draft)}else if(e.key==='Escape'){e.preventDefault();finish(null)}}}/>
}

export function SampleDot({engine,setId}:{engine:AudioEngine;setId?:string}){
  const status=useSyncExternalStore(engine.subscribeSamples,()=>setId?engine.sampleStatus(setId):'idle',()=>'idle' as const)
  if(status==='loading')return <i className="sample-dot loading" title="샘플을 불러오는 중" aria-label="샘플을 불러오는 중"/>
  if(status==='error')return <i className="sample-dot error" title="샘플을 불러오지 못했습니다" aria-label="샘플을 불러오지 못했습니다"/>
  return null
}

type ClipActions={beginClipGesture:(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip,mode:GestureMode)=>void;clipMenu:(e:React.MouseEvent,track:Track,clip:Clip)=>void;select:(trackId:string,clipId:string)=>void;open:(trackId:string,clipId:string)=>void;renameDone:(clipId:string,name:string|null)=>void}
const TimelineClip=memo(function TimelineClip({clip,track,asset,ppb,selected,preview,renaming,actions}:{clip:Clip;track:Track;asset?:AudioAsset;ppb:number;selected:boolean;preview?:Preview;renaming:boolean;actions:React.RefObject<ClipActions>}){
  const onSelect=(trackId:string,clipId:string)=>actions.current.select(trackId,clipId)
  const notes=clip.kind==='midi'?clip.notes:[]
  const min=notes.length?Math.min(...notes.map(n=>n.pitch)):48,max=notes.length?Math.max(...notes.map(n=>n.pitch)):72
  const length=preview?.length??clip.lengthBeats
  return <div className={`timeline-clip ${selected?'clip-selected':''} ${preview?'clip-moving':''} ${clip.mute?'clip-muted':''} ${clip.kind}`} tabIndex={0} role="button" aria-pressed={selected} aria-label={`${clip.name}, ${clip.startBeat/4+1} 마디${clip.mute?', 뮤트됨':''}`} onFocus={()=>{if(!focusFromPointer&&!selected)onSelect(track.id,clip.id)}} onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'move')} onDoubleClick={e=>{if(!(e.target as Element).closest('input'))actions.current.open(track.id,clip.id)}} onContextMenu={e=>actions.current.clipMenu(e,track,clip)} onKeyDown={e=>{if(e.key==='Enter'&&isUnmodified(e.nativeEvent)&&!isShortcutSuppressed(e.nativeEvent,true)){e.preventDefault();e.stopPropagation();if(!e.repeat)onSelect(track.id,clip.id)}}} style={{left:(preview?.start??clip.startBeat)*ppb,width:Math.max(3,length*ppb-2),transform:preview?.dy?`translateY(${preview.dy}px)`:undefined,'--clip-color':track.color} as React.CSSProperties}>
    <div className="clip-title"><Icon name={clip.kind==='audio'?'wave':'note'} size={11}/>{renaming?<InlineName value={clip.name} label="클립 이름" onDone={name=>actions.current.renameDone(clip.id,name)}/>:<span>{clip.name}</span>}{clip.mute&&<b className="clip-mute-badge" aria-hidden="true">M</b>}<span className="clip-corner-dot"/></div>
    <div className="clip-preview">{clip.kind==='audio'&&asset?<Waveform peaks={asset.peaks}/>:<svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(.01,clip.lengthBeats)*20} 32`} aria-hidden="true">{notes.filter(n=>n.start<clip.lengthBeats).map(n=><rect key={n.id} x={n.start*20} y={3+(1-(n.pitch-min)/Math.max(12,max-min))*23} width={Math.max(1,Math.min(n.duration,clip.lengthBeats-n.start)*20-1)} height={instrumentDef(track.instrument).isKit?4:2.5} rx=".7" fill="currentColor" opacity={.45+n.velocity*.5}/>)}</svg>}</div>
    <div className="clip-resize-left" title="드래그하여 시작 지점 자르기" onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'trimStart')}/>
    <div className="clip-resize" title="드래그하여 클립 길이 조절" onPointerDown={e=>actions.current.beginClipGesture(e,track,clip,'trimEnd')}/>
  </div>
})

function Playhead({engine,ppb,scrollRef,followRef}:{engine:AudioEngine;ppb:number;scrollRef:React.RefObject<HTMLDivElement|null>;followRef:React.RefObject<boolean>}){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{let raf=0;const frame=()=>{const s=engine.getSnapshot(),x=s.beat*ppb;if(ref.current)ref.current.style.transform=`translateX(${x}px)`
    // Page-follow: when the playhead leaves the view during playback, bring it back at 10%.
    const scroll=scrollRef.current;if(scroll&&followRef.current&&s.playing&&!document.querySelector('[data-daw-gesture]')){const visible=scroll.clientWidth-HEADER_WIDTH;if(visible>40&&(x<scroll.scrollLeft||x>scroll.scrollLeft+visible-8))scroll.scrollLeft=Math.max(0,x-visible*.1)}
    raf=requestAnimationFrame(frame)};frame();return()=>cancelAnimationFrame(raf)},[engine,ppb,scrollRef,followRef])
  return <div className="playhead" ref={ref}><i/></div>
}
export function MiniMeter({engine,trackId,color='#9fcfb4',vertical=false}:{engine:AudioEngine;trackId?:string;color?:string;vertical?:boolean}){
  const ref=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{let raf=0;let held=0;let last=0;const frame=(now:number)=>{if(now-last>33){last=now;const c=ref.current;const ctx=c?.getContext('2d');if(c&&ctx){const value=trackId?engine.getTrackLevel(trackId):engine.getMasterLevel();held=Math.max(value,held*.88);const fill=Math.min(1,Math.sqrt(held)*1.6);ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#2d2a25';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle=held>.85?'#e5533d':color;if(vertical)ctx.fillRect(0,c.height*(1-fill),c.width,c.height*fill);else ctx.fillRect(0,0,c.width*fill,c.height)}}raf=requestAnimationFrame(frame)};raf=requestAnimationFrame(frame);return()=>cancelAnimationFrame(raf)},[engine,trackId,color,vertical])
  return <canvas ref={ref} width={vertical?5:38} height={vertical?120:4} className={vertical?'meter-vertical':'mini-meter'} aria-label="실시간 오디오 레벨"/>
}
