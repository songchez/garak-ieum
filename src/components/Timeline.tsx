import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AudioAsset, AudioEngine, Clip, Marker, Project, Track } from '../core/types'
import { MIN_CLIP_BEATS, trimClipStart, visibleTracks, type ClipStartTrim } from '../core/project'
import { audibleTracks, effectiveArm, type TrackButtonKind } from '../core/trackActions'
import { isTrackEnabled } from '../core/playback'
import { previewRegionTracks, type RegionPlacement } from '../core/regionDisplay'
import { DEFAULT_HEADER_WIDTH, DRAG_MODES, DRAG_MODE_LABELS, HEADER_WIDTH_LIMITS, SNAP_MODE_LABELS, TRACK_ZOOM_LIMITS, resolveSnap, type DragMode, type SnapMode, type TrackHeaderConfig } from '../core/trackUi'
import { Icon } from './Icon'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { crossedDragThreshold, dragModifiers, isShortcutSuppressed, isUnmodified, shortcutLabel, shortcutPlatform, type ProjectShortcut } from '../core/input'
import { ZOOM_LIMITS, zoomAround, zoomBy } from '../core/zoom'
import { useZoomWheel } from './useZoomWheel'
import { ZoomControls } from './ZoomControls'
import { TrackHeader } from './TrackHeader'
import { InlineName, TimelineClip, pointerFocus, type ClipActions, type GestureMode, type Preview } from './TimelineClip'
import './Timeline.css'

/** Default header column width; the live value is `ui.headerWidth`. */
export const HEADER_WIDTH = DEFAULT_HEADER_WIDTH
export const MIN_PPB = ZOOM_LIMITS.timelineX.min, MAX_PPB = ZOOM_LIMITS.timelineX.max
const RULER_HEIGHT = 38, GLOBAL_ROW_HEIGHT = 22
const ROW_LIMITS = { min: 36, max: 320 }
const FOCUS_ZOOM = 2.5
/** Legacy six-colour set; the palette (core/colors.ts) replaces it. */
export const TRACK_COLORS = [['#6f9fd0','하늘'],['#7fb59a','숲'],['#e38457','노을'],['#8cc7c0','물빛'],['#d98a9f','꽃잎'],['#d9b45a','황금']] as const
const CYCLE_BAND = 16
const EDGE = 24, EDGE_STEP = 10

export type { GestureMode, Preview } from './TimelineClip'
type DragState = {mode:GestureMode;ids:Set<string>;dBeat:number;dRow:number;copy:boolean;rowTops:number[]}
type MenuState = {x:number;y:number;items:ContextMenuItem[];label:string;trigger?:Element|null}
type ClickMods = {range:boolean;toggle:boolean;trackOnly:boolean}
type Point = {x:number;y:number}

export interface TimelineUi {
  headerWidth:number; headerConfig:TrackHeaderConfig; hideView:boolean; recording:boolean; catch:boolean; scrollInPlay:boolean
  snap:{on:boolean;mode:SnapMode;relative:boolean}; dragMode:DragMode; globalTracks:boolean; gridLines:boolean
  trackZoom:Record<string,number>; zoomFocused:boolean; soloRecall:string[]|null; renamingTrackId:string|null
}
export interface TimelineProps {
  project:Project; assets:Map<string,AudioAsset>; engine:AudioEngine
  focusedTrackId:string; selectedTrackIds:ReadonlySet<string>; selectedClipIds:ReadonlySet<string>; anchorClipId:string|null
  ui:TimelineUi
  zoom:{ppb:number;rowHeight:number}
  onUiChange(patch:Partial<TimelineUi>):void
  onZoomChange(patch:Partial<{ppb:number;rowHeight:number}>):void
  onTrackClick(id:string,mods:ClickMods):void
  onTrackFocus(id:string):void
  onTrackButton(trackId:string,kind:TrackButtonKind,mods:{alt:boolean;mod:boolean;soloSafe:boolean}):void
  onTrackSweep(trackId:string,kind:TrackButtonKind,value:boolean):void
  onTracksChange(patches:{id:string;patch:Partial<Track>}[],key?:string):void
  onTracksReorder(ids:string[],afterId:string|null):void
  onNewTrack(opts:{kind?:'instrument'|'audio';sameAsFocused?:boolean;empty?:boolean;dialog?:boolean;afterId?:string|null}):void
  onDuplicateTracks(ids:string[],mode:'settings'|'content'):void
  onDeleteTracks(ids:string[]):void
  onRenameTracks(ids:string[],name:string|null):void
  onOpenLibrary(id:string):void
  onOpenColorPalette(ids:string[],e:Point):void
  onIconMenu(id:string,e:Point):void
  onConfigureHeader(e:Point):void
  onClearRecallSolo():void
  onSeek(beat:number):void; onSeekPlay(beat:number):void
  onLoopChange(loop:{enabled:boolean;startBeat:number;endBeat:number}):void
  onSelectClips(ids:string[],anchor:string|null,trackId?:string):void
  onClipMove(moves:{trackId:string;clipId:string;start:number;length?:number;toTrackId?:string}[],copy:boolean):void
  onClipTrimStart(trims:readonly ClipStartTrim[]):void
  onClipLoopToggle(trackId:string,clipId:string):void
  onAddClip(trackId:string,beat:number):void
  onAudioDrop(files:FileList,trackId?:string,beat?:number):void
  onCommand(command:ProjectShortcut,ctx?:{trackIds?:string[];clipIds?:string[]}):void
  onMarker(action:'add'|'move'|'rename'|'delete',payload:{id?:string;beat?:number;name?:string}):void
  /** Optional extras outside the §3.1 contract: clip double-click opens its editor; inline clip rename state. Without them a double-click only selects. */
  onClipOpen?(trackId:string,clipId:string):void
  renamingClipId?:string|null
  onClipRename?(clipId:string,name:string|null):void
}

const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v))
const MAC=shortcutPlatform()==='mac'
const ALT=MAC?'⌥':'Alt+', MOD=MAC?'⌘':'Ctrl+'
const SEP:ContextMenuItem={type:'separator'}

/** Scrolls the timeline while a gesture's pointer rests near an edge. */
function edgeScroller(scroll:HTMLElement,headerWidth:()=>number,onScroll:()=>void){
  let x=0,y=0,armed=false,raf=0
  const tick=()=>{
    if(armed){const r=scroll.getBoundingClientRect();const dx=x<r.left+headerWidth()+EDGE?-EDGE_STEP:x>r.right-EDGE?EDGE_STEP:0;const dy=y<r.top+RULER_HEIGHT+EDGE?-EDGE_STEP:y>r.bottom-EDGE?EDGE_STEP:0
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

const isToggleClick=(e:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean})=>e.shiftKey||(MAC?e.metaKey:e.ctrlKey)
const plainMods:ClickMods={range:false,toggle:false,trackOnly:false}

export function Timeline(props:TimelineProps){
  const {project,assets,engine,focusedTrackId,selectedTrackIds,selectedClipIds,ui}=props
  const ppb=props.zoom.ppb,rowHeight=Math.round(props.zoom.rowHeight),headerWidth=ui.headerWidth
  const scrollRef=useRef<HTMLDivElement>(null)
  const sheetRef=useRef<HTMLDivElement>(null)
  const rulerPlayhead=useRef<HTMLDivElement>(null)
  const latest=useRef(props);latest.current=props
  const [fileOver,setFileOver]=useState(false)
  const [drag,setDrag]=useState<DragState|null>(null)
  const [marquee,setMarquee]=useState<{x:number;y:number;w:number;h:number;ids:Set<string>;add:boolean}|null>(null)
  const [loopDraft,setLoopDraft]=useState<{start:number;end:number}|null>(null)
  const [trackDrop,setTrackDrop]=useState<{ids:Set<string>;index:number;y:number}|null>(null)
  const [markerDrag,setMarkerDrag]=useState<{id:string;beat:number}|null>(null)
  const [markerState,setMarkerState]=useState<{selected:string|null;renaming:string|null}>({selected:null,renaming:null})
  const [menu,setMenu]=useState<MenuState|null>(null)
  const cancelGesture=useRef<(()=>void)|null>(null)
  const zoomAnchor=useRef<{beat:number;px:number}|null>(null)
  const prevPpb=useRef(ppb)
  const rowAnchor=useRef<number|null>(null)
  const prevRow=useRef(rowHeight)
  const expectedScroll=useRef<number|null>(null)
  const lastScrollLeft=useRef(0)
  useEffect(()=>()=>cancelGesture.current?.(),[])

  const snapBeats=resolveSnap(ui.snap,ppb)
  const rows=visibleTracks(project,ui.hideView)
  const rowIndex=new Map(rows.map((t,i)=>[t.id,i]))
  const trackNumber=new Map(project.tracks.map((t,i)=>[t.id,i+1]))
  const clipTrack=new Map(rows.flatMap(t=>t.clips.map(c=>[c.id,t] as const)))
  const audible=audibleTracks(project)
  const contentEnd=Math.max(project.lengthBeats,...project.tracks.flatMap(t=>t.clips.map(c=>c.startBeat+c.lengthBeats)),...project.markers.map(m=>m.startBeat))
  const width=(contentEnd+8)*ppb
  const heightOf=(track:Track)=>{let f=ui.trackZoom[track.id]??1;if(ui.zoomFocused&&track.id===focusedTrackId)f=Math.max(f,FOCUS_ZOOM);return Math.round(clamp(rowHeight*f,ROW_LIMITS.min,ROW_LIMITS.max))}
  const sheetPoint=(clientX:number,clientY:number)=>{const r=sheetRef.current!.getBoundingClientRect();return{x:clientX-r.left,y:clientY-r.top}}
  const rowEls=()=>Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(':scope > .track-row')??[])
  const rowTops=()=>rowEls().map(row=>row.offsetTop)
  const rowHeights=()=>rowEls().map(row=>row.offsetHeight)
  const rowAt=(tops:number[],y:number)=>{let index=0;for(let i=0;i<tops.length;i++)if(y>=tops[i])index=i;return index}
  const markScroll=(left:number)=>{expectedScroll.current=left}
  const laneBeat=(lane:Element,clientX:number)=>Math.max(0,(clientX-lane.getBoundingClientRect().left)/ppb)
  const snapBeat=(beat:number,unit=snapBeats)=>unit>0?Math.round(beat/unit)*unit:beat
  /** Grid unit for a gesture: Ctrl = quarter grid, Ctrl+Shift = none. */
  const unitFor=(e:{altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean})=>{const m=dragModifiers(e);return m.noSnap?0:m.fine?snapBeats/4:snapBeats}
  /** Absolute snap lands the dragged edge on the grid; relative keeps the original offset. */
  const deltaFor=(raw:number,origin:number,e:{altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean})=>{const u=unitFor(e);if(!(u>0))return raw;return ui.snap.relative?Math.round(raw/u)*u:Math.round((origin+raw)/u)*u-origin}

  // Ctrl/⌘ + wheel zooms time, Ctrl/⌘ + Shift (or Alt) + wheel zooms track height, both around the pointer.
  useZoomWheel(scrollRef,{
    onZoomX:(factor,x)=>{
      const scroll=scrollRef.current!,current=latest.current.zoom.ppb,hw=latest.current.ui.headerWidth,px=Math.max(hw,x)
      const next=zoomBy(current,factor,ZOOM_LIMITS.timelineX)
      if(Math.abs(next-current)<.01)return
      zoomAnchor.current={beat:(scroll.scrollLeft+px-hw)/current,px}
      latest.current.onZoomChange({ppb:next})
    },
    onZoomY:(factor,y)=>{
      const current=latest.current.zoom.rowHeight,next=zoomBy(current,factor,ZOOM_LIMITS.timelineY)
      if(Math.abs(next-current)<.01)return
      rowAnchor.current=Math.max(RULER_HEIGHT,y)
      latest.current.onZoomChange({rowHeight:next})
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
    const hw=latest.current.ui.headerWidth
    let anchor=zoomAnchor.current;zoomAnchor.current=null
    if(!anchor){const beat=engine.getSnapshot().beat,px=beat*previous+hw-scroll.scrollLeft;anchor=px>=hw&&px<=scroll.clientWidth?{beat,px}:{beat:scroll.scrollLeft/previous,px:hw}}
    markScroll(scroll.scrollLeft=Math.max(0,anchor.beat*ppb+hw-anchor.px))
  },[ppb,engine])

  /** A user horizontal scroll during playback turns Catch off (R-06); programmatic scrolls are marked first. */
  function onScroll(e:React.UIEvent<HTMLDivElement>){
    const left=e.currentTarget.scrollLeft
    if(Math.abs(left-lastScrollLeft.current)<.5)return
    lastScrollLeft.current=left
    const programmatic=expectedScroll.current!==null&&Math.abs(left-expectedScroll.current)<1
    expectedScroll.current=null
    if(programmatic||!latest.current.ui.catch||!engine.getSnapshot().playing||document.querySelector('[data-daw-gesture]'))return
    latest.current.onUiChange({catch:false})
  }

  function openMenu(e:React.MouseEvent,items:ContextMenuItem[],label:string,trigger?:Element|null){e.preventDefault();e.stopPropagation();cancelGesture.current?.();setMenu({x:e.clientX,y:e.clientY,items,label,trigger})}
  function openMenuAt(x:number,y:number,items:ContextMenuItem[],label:string,trigger?:Element|null){cancelGesture.current?.();setMenu({x,y,items,label,trigger})}
  const cmd=(label:string,command:ProjectShortcut,extra:Partial<Extract<ContextMenuItem,{label:string}>>={},ctx?:{trackIds?:string[];clipIds?:string[]}):ContextMenuItem=>({label,shortcut:shortcutLabel(command)||undefined,onSelect:()=>latest.current.onCommand(command,ctx),...extra})
  /** Tracks a header action applies to: the whole selection when the clicked track belongs to it. */
  const targetIds=(trackId:string)=>{const sel=latest.current.selectedTrackIds;return sel.has(trackId)?latest.current.project.tracks.filter(t=>sel.has(t.id)).map(t=>t.id):[trackId]}

  function clipMenu(e:React.MouseEvent,track:Track,clip:Clip){
    const selected=selectedClipIds.has(clip.id)
    if(!selected)props.onSelectClips([clip.id],clip.id,track.id)
    const ids=selected?[...selectedClipIds]:[clip.id],count=ids.length,ctx={clipIds:ids,trackIds:[track.id]}
    openMenu(e,[cmd('잘라내기','cut',{},ctx),cmd('복사','copy',{},ctx),cmd('붙여넣기','paste',{},ctx),SEP,cmd('반복','repeat',{},ctx),cmd('재생 위치에서 분할','split',{},ctx),cmd('합치기','join',{disabled:count<2},ctx),SEP,cmd('루프','loopClip',{checked:!!clip.loop},ctx),cmd('뮤트','muteClip',{checked:!!clip.mute},ctx),cmd('이름 바꾸기','renameClip',{},ctx),SEP,cmd(count>1?`클립 ${count}개 삭제`:'삭제','deleteClip',{danger:true},ctx)],'클립 메뉴')
  }
  function trackMenu(e:React.MouseEvent,track:Track){
    if(!selectedTrackIds.has(track.id))props.onTrackClick(track.id,plainMods)
    const ids=targetIds(track.id),n=ids.length,at={x:e.clientX,y:e.clientY}
    const unused=project.tracks.filter(t=>!t.clips.length).map(t=>t.id)
    const cfgItem=(key:keyof TrackHeaderConfig,label:string):ContextMenuItem=>({label,checked:ui.headerConfig[key],onSelect:()=>{const cfg=latest.current.ui.headerConfig;latest.current.onUiChange({headerConfig:{...cfg,[key]:!cfg[key]}})}})
    openMenu(e,[
      {label:n>1?`${n}개 트랙 이름 변경`:'트랙 이름 변경',shortcut:shortcutLabel('renameTrack')||undefined,onSelect:()=>latest.current.onUiChange({renamingTrackId:track.id})},
      SEP,
      {label:'새 오디오 트랙',shortcut:shortcutLabel('newAudioTrack')||undefined,onSelect:()=>latest.current.onNewTrack({kind:'audio',afterId:track.id})},
      {label:'새 소프트웨어 악기 트랙',shortcut:shortcutLabel('newInstrumentTrack')||undefined,onSelect:()=>latest.current.onNewTrack({kind:'instrument',afterId:track.id})},
      {label:'설정을 복제한 새로운 트랙',shortcut:shortcutLabel('duplicateTrack')||undefined,onSelect:()=>latest.current.onDuplicateTracks(ids,'settings')},
      {label:'설정 및 콘텐츠를 복제한 새로운 트랙',shortcut:shortcutLabel('duplicateTrackContent')||undefined,onSelect:()=>latest.current.onDuplicateTracks(ids,'content')},
      SEP,
      {label:'트랙 색상 지정…',shortcut:shortcutLabel('colorPalette')||undefined,onSelect:()=>latest.current.onOpenColorPalette(ids,at)},
      {label:'트랙 아이콘…',onSelect:()=>latest.current.onIconMenu(track.id,at)},
      SEP,
      {label:n>1?`트랙 ${n}개 삭제`:'트랙 삭제',shortcut:shortcutLabel('deleteTrack')||undefined,danger:true,onSelect:()=>latest.current.onDeleteTracks(ids)},
      ...(unused.length?[{label:'사용하지 않는 트랙 삭제',onSelect:()=>latest.current.onDeleteTracks(unused)} as ContextMenuItem]:[]),
      SEP,
      {label:'선택한 트랙 가리기',shortcut:shortcutLabel('hideSelectedTracks')||undefined,onSelect:()=>latest.current.onCommand('hideSelectedTracks',{trackIds:ids})},
      {label:'보기 가리기 토글',shortcut:shortcutLabel('toggleHideView')||undefined,checked:ui.hideView,onSelect:()=>latest.current.onUiChange({hideView:!latest.current.ui.hideView})},
      {label:'트랙 가리기 모두 해제',shortcut:shortcutLabel('unhideAllTracks')||undefined,disabled:!project.tracks.some(t=>t.hidden),onSelect:()=>latest.current.onCommand('unhideAllTracks')},
      SEP,
      {label:'트랙 헤더 구성 요소',items:[cfgItem('mute','음소거'),cfgItem('solo','솔로'),cfgItem('record','녹음 가능'),cfgItem('monitor','입력 모니터링'),cfgItem('onOff','켬/끔'),cfgItem('hide','가리기'),SEP,cfgItem('volume','볼륨'),cfgItem('pan','팬'),SEP,cfgItem('trackNumber','트랙 번호'),cfgItem('colorBar','색상 막대'),cfgItem('icon','트랙 아이콘')]},
      {label:'트랙 헤더 구성…',shortcut:shortcutLabel('configureTrackHeader')||undefined,onSelect:()=>latest.current.onConfigureHeader(at)},
    ],'트랙 메뉴')
  }
  function laneMenu(e:React.MouseEvent,track:Track){
    const bar=Math.floor(laneBeat(e.currentTarget,e.clientX)/4)*4
    if(!selectedTrackIds.has(track.id))props.onTrackClick(track.id,{...plainMods,trackOnly:true})
    openMenu(e,[cmd('붙여넣기','paste',{},{trackIds:[track.id]}),SEP,track.kind==='audio'?{label:'오디오 가져오기…',onSelect:()=>latest.current.onAddClip(track.id,bar)}:{label:'MIDI 클립 만들기',onSelect:()=>latest.current.onAddClip(track.id,bar)},SEP,{label:'새 트랙…',shortcut:shortcutLabel('newTracksDialog')||undefined,onSelect:()=>latest.current.onNewTrack({dialog:true,afterId:track.id})}],'레인 메뉴')
  }
  function emptyAreaMenu(e:React.MouseEvent){
    openMenu(e,[{label:'새 오디오 트랙',shortcut:shortcutLabel('newAudioTrack')||undefined,onSelect:()=>latest.current.onNewTrack({kind:'audio',afterId:null})},{label:'새 소프트웨어 악기 트랙',shortcut:shortcutLabel('newInstrumentTrack')||undefined,onSelect:()=>latest.current.onNewTrack({kind:'instrument',afterId:null})},SEP,{label:'새 트랙…',shortcut:shortcutLabel('newTracksDialog')||undefined,onSelect:()=>latest.current.onNewTrack({dialog:true,afterId:null})}],'트랙 추가 메뉴')
  }
  function markerMenu(e:React.MouseEvent,marker:Marker){
    setMarkerState({selected:marker.id,renaming:null})
    openMenu(e,[{label:'마커 이름 변경',onSelect:()=>setMarkerState({selected:marker.id,renaming:marker.id})},{label:'재생 위치로 이동',onSelect:()=>latest.current.onSeek(marker.startBeat)},SEP,{label:'마커 삭제',danger:true,onSelect:()=>latest.current.onMarker('delete',{id:marker.id})}],'마커 메뉴')
  }

  // Menu bar popups (Logic: 편집 · 기능 · 보기 · Catch · Snap · Drag)
  function barMenu(e:React.MouseEvent<HTMLButtonElement>,items:ContextMenuItem[],label:string){
    if(menu?.trigger===e.currentTarget){setMenu(null);return}
    const r=e.currentTarget.getBoundingClientRect();openMenuAt(r.left,r.bottom+2,items,label,e.currentTarget)
  }
  const selCtx=()=>({clipIds:[...latest.current.selectedClipIds],trackIds:[...latest.current.selectedTrackIds]})
  const editMenu=():ContextMenuItem[]=>[cmd('실행 취소','undo'),cmd('다시 실행','redo'),SEP,cmd('잘라내기','cut',{},selCtx()),cmd('복사','copy',{},selCtx()),cmd('붙여넣기','paste',{},selCtx()),cmd('삭제','deleteClip',{},selCtx()),SEP,cmd('재생 위치에서 분할','split',{},selCtx()),cmd('합치기','join',{disabled:selectedClipIds.size<2},selCtx()),cmd('반복','repeat',{},selCtx()),SEP,cmd('모두 선택','selectAll')]
  const functionsMenu=():ContextMenuItem[]=>[cmd('리전 뮤트','muteClip',{disabled:!selectedClipIds.size},selCtx()),cmd('루프','loopClip',{disabled:!selectedClipIds.size},selCtx()),cmd('재생 위치로 이동','moveToPlayhead',{disabled:!selectedClipIds.size},selCtx()),cmd('이름 변경','renameClip',{disabled:!selectedClipIds.size},selCtx())]
  const uiToggle=(label:string,key:'globalTracks'|'hideView'|'scrollInPlay'|'gridLines'|'zoomFocused'|'catch',command?:ProjectShortcut):ContextMenuItem=>({label,checked:ui[key],shortcut:command?shortcutLabel(command)||undefined:undefined,onSelect:()=>latest.current.onUiChange({[key]:!latest.current.ui[key]} as Partial<TimelineUi>)})
  const viewMenu=():ContextMenuItem[]=>[cmd('인스펙터 보기','toggleInspector'),cmd('라이브러리 보기','toggleLibrary'),cmd('브라우저 보기','toggleBrowser'),SEP,uiToggle('글로벌 트랙 보기','globalTracks','globalTracks'),uiToggle('보기 가리기 토글','hideView','toggleHideView'),{label:'트랙 헤더 구성…',shortcut:shortcutLabel('configureTrackHeader')||undefined,onSelect:()=>{const b=document.querySelector('.tracks-menubar [data-menu="view"]')?.getBoundingClientRect();latest.current.onConfigureHeader({x:b?.left??0,y:b?.bottom??0})}},SEP,uiToggle('재생 중 스크롤','scrollInPlay'),uiToggle('그리드 선','gridLines'),uiToggle('포커스된 트랙 확대/축소','zoomFocused','zoomFocusedTrack')]
  const snapMenu=():ContextMenuItem[]=>{
    const set=(patch:Partial<TimelineUi['snap']>)=>latest.current.onUiChange({snap:{...latest.current.ui.snap,...patch}})
    const modes:SnapMode[]=['smart','bar','beat','division','ticks']
    return [{label:'그리드에 스냅',checked:ui.snap.on,shortcut:shortcutLabel('snapToggle')||undefined,onSelect:()=>set({on:!latest.current.ui.snap.on})},SEP,...modes.map(mode=>({label:SNAP_MODE_LABELS[mode],checked:ui.snap.mode===mode,onSelect:()=>set({mode,on:true})} as ContextMenuItem)),SEP,{label:'절대값 스냅',checked:!ui.snap.relative,onSelect:()=>set({relative:false})},{label:'상대값 스냅',checked:ui.snap.relative,onSelect:()=>set({relative:true})}]
  }
  const dragMenu=():ContextMenuItem[]=>DRAG_MODES.map(mode=>({label:DRAG_MODE_LABELS[mode],checked:ui.dragMode===mode,onSelect:()=>latest.current.onUiChange({dragMode:mode})}))

  /** Move or trim every selected clip together. The grabbed clip decides the row origin. */
  function beginClipGesture(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip,mode:GestureMode,captureTarget?:HTMLElement|null){
    if(e.button!==0)return
    // macOS Ctrl-click is the secondary click; the contextmenu event follows.
    if(MAC&&e.ctrlKey)return
    e.stopPropagation();e.preventDefault();cancelGesture.current?.()
    // A loop repeat may disappear as its region moves. Capture the stable original in that case.
    const target=captureTarget??e.currentTarget.closest<HTMLElement>('.timeline-clip')??e.currentTarget
    const scroll=scrollRef.current,sheet=sheetRef.current;if(!scroll||!sheet)return
    const wasSelected=selectedClipIds.has(clip.id),toggle=isToggleClick(e)
    let ids:Set<string>
    if(!wasSelected){ids=toggle?new Set([...selectedClipIds,clip.id]):new Set([clip.id]);props.onSelectClips([...ids],clip.id,track.id)}
    else ids=new Set([...selectedClipIds].filter(id=>clipTrack.has(id)))
    if(!ids.size)ids=new Set([clip.id])
    pointerFocus(target)
    const tops=rowTops(),originRow=rowIndex.get(track.id)??0
    const origin={x:e.clientX,y:e.clientY,left:scroll.scrollLeft,top:scroll.scrollTop}
    const group=[...ids].map(id=>{const t=clipTrack.get(id)!;return{clip:t.clips.find(c=>c.id===id)!,row:rowIndex.get(t.id)!,kind:t.kind,track:t}})
    const minStart=Math.min(...group.map(g=>g.clip.startBeat))
    const snapOrigin=mode==='trimEnd'?clip.startBeat+clip.lengthBeats:clip.startBeat
    let state:DragState={mode,ids,dBeat:0,dRow:0,copy:false,rowTops:tops},started=false,last:PointerEvent|null=null
    const validRow=(d:number)=>group.every(g=>{const t=rows[g.row+d];return!!t&&t.kind===g.kind})
    const compute=(event:PointerEvent)=>{
      last=event
      const dx=event.clientX-origin.x+scroll.scrollLeft-origin.left,dy=event.clientY-origin.y+scroll.scrollTop-origin.top
      if(!started&&!crossedDragThreshold(dx,dy))return
      if(!started){started=true;sheet.closest('.arrangement')?.classList.add('clip-gesture')}
      scroller.update(event.clientX,event.clientY)
      const mods=dragModifiers(event)
      let dBeat=deltaFor(dx/ppb,snapOrigin,event),dRow=0
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
    const scroller=edgeScroller(scroll,()=>latest.current.ui.headerWidth,()=>{if(last)compute(last)})
    const stop=trackPointer(target,e.pointerId,mode==='move'?'move':'resize',{move:compute,end:(commit,event)=>{
      scroller.stop();cancelGesture.current=null;setDrag(null);sheet.closest('.arrangement')?.classList.remove('clip-gesture')
      if(!commit)return
      if(!started){
        // A click without movement: modifier toggles a selected clip off, a plain click narrows to it.
        if(wasSelected){
          if(toggle){const rest=[...latest.current.selectedClipIds].filter(id=>id!==clip.id);latest.current.onSelectClips(rest,rest.includes(latest.current.anchorClipId??'')?latest.current.anchorClipId:rest[0]??null,track.id)}
          else latest.current.onSelectClips([clip.id],clip.id,track.id)
        }
        return
      }
      if(event&&mode==='move')state={...state,copy:dragModifiers(event).copy}
      if(Math.abs(state.dBeat)<1e-9&&state.dRow===0&&!state.copy)return
      if(mode==='move')latest.current.onClipMove(group.map(g=>{const to=rows[g.row+state.dRow];return{trackId:g.track.id,clipId:g.clip.id,start:g.clip.startBeat+state.dBeat,toTrackId:to&&to.id!==g.track.id?to.id:undefined}}),state.copy)
      else if(mode==='trimEnd')latest.current.onClipMove(group.map(g=>({trackId:g.track.id,clipId:g.clip.id,start:g.clip.startBeat,length:trimEndLength(g.clip,state.dBeat)})),false)
      else latest.current.onClipTrimStart(group.map(g=>({trackId:g.track.id,clipId:g.clip.id,newStart:g.clip.startBeat+state.dBeat})))
    }})
    cancelGesture.current=stop
  }
  function trimEndLength(clip:Clip,dBeat:number){
    const asset=clip.kind==='audio'?assets.get(clip.assetId):undefined
    const max=asset&&clip.kind==='audio'?Math.max(MIN_CLIP_BEATS,(asset.buffer.duration-clip.offsetSeconds)*project.bpm/60):Infinity
    return Math.min(max,Math.max(MIN_CLIP_BEATS,clip.lengthBeats+dBeat))
  }

  /** Loop pointer zone: a click toggles; dragging to the right past the clip end turns the loop on. */
  function loopHandle(e:React.PointerEvent<HTMLElement>,track:Track,clip:Clip){
    if(e.button!==0||(MAC&&e.ctrlKey))return
    e.stopPropagation();e.preventDefault();cancelGesture.current?.()
    const target=e.currentTarget,startX=e.clientX
    let dx=0
    cancelGesture.current=trackPointer(target,e.pointerId,'loop',{move:ev=>{dx=ev.clientX-startX},end:commit=>{
      cancelGesture.current=null
      if(!commit)return
      if(!crossedDragThreshold(dx))latest.current.onClipLoopToggle(track.id,clip.id)
      else if(dx>0&&!clip.loop)latest.current.onClipLoopToggle(track.id,clip.id)
    }})
  }

  /** Rubber-band selection across tracks and time, started on an empty lane. ⇧click without movement seeks. */
  function beginMarquee(e:React.PointerEvent<HTMLElement>,track:Track){
    if(e.button!==0||e.target!==e.currentTarget)return
    const scroll=scrollRef.current,sheet=sheetRef.current;if(!scroll||!sheet)return
    cancelGesture.current?.()
    const lane=e.currentTarget,downBeat=laneBeat(lane,e.clientX)
    const start=sheetPoint(e.clientX,e.clientY),tops=rowTops(),heights=rowHeights(),add=e.shiftKey
    const hw=headerWidth
    let started=false,last:PointerEvent|null=null,ids=new Set<string>()
    const compute=(event:PointerEvent)=>{
      last=event
      const p=sheetPoint(event.clientX,event.clientY)
      if(!started&&!crossedDragThreshold(p.x-start.x,p.y-start.y))return
      started=true;scroller.update(event.clientX,event.clientY)
      const x0=Math.min(start.x,p.x),x1=Math.max(start.x,p.x),y0=Math.min(start.y,p.y),y1=Math.max(start.y,p.y)
      const b0=(x0-hw)/ppb,b1=(x1-hw)/ppb
      ids=new Set(rows.flatMap((t,i)=>tops[i]<y1&&tops[i]+heights[i]>y0?t.clips.filter(c=>c.startBeat<b1&&c.startBeat+c.lengthBeats>b0).map(c=>c.id):[]))
      setMarquee({x:Math.max(hw,x0),y:y0,w:x1-Math.max(hw,x0),h:y1-y0,ids,add})
    }
    const scroller=edgeScroller(scroll,()=>latest.current.ui.headerWidth,()=>{if(last)compute(last)})
    cancelGesture.current=trackPointer(lane,e.pointerId,'marquee',{move:compute,end:commit=>{
      scroller.stop();cancelGesture.current=null;setMarquee(null)
      if(!commit)return
      const cur=latest.current
      if(started){const all=add?new Set([...cur.selectedClipIds,...ids]):ids;const anchor=add&&cur.anchorClipId&&all.has(cur.anchorClipId)?cur.anchorClipId:[...ids][0]??null;cur.onSelectClips([...all],anchor,track.id)}
      else if(e.shiftKey)cur.onSeek(Math.min(cur.project.lengthBeats,snapBeat(downBeat)))
      else{cur.onTrackClick(track.id,{...plainMods,trackOnly:true});cur.onSelectClips([],null,track.id)}
    }})
  }

  /** Top band: cycle (click = toggle, drag = create/move/resize, ⇧click = extend). Lower band: seek/scrub. */
  function beginRuler(e:React.PointerEvent<HTMLElement>,scrub?:HTMLElement){
    if(e.button!==0||(MAC&&e.ctrlKey))return
    const ruler=scrub??e.currentTarget,rect=ruler.getBoundingClientRect(),y=e.clientY-rect.top
    const beatAt=(clientX:number)=>Math.max(0,(clientX-ruler.getBoundingClientRect().left)/ppb)
    const scroll=scrollRef.current!
    cancelGesture.current?.()
    if(scrub||y>=CYCLE_BAND){
      e.preventDefault();e.stopPropagation()
      const seek=(event:{clientX:number;shiftKey:boolean;altKey:boolean;ctrlKey:boolean;metaKey:boolean})=>{let beat=beatAt(event.clientX);const noSnap=dragModifiers(event).noSnap||event.shiftKey;if(!noSnap)beat=snapBeat(beat);latest.current.onSeek(Math.min(latest.current.project.lengthBeats,beat))}
      seek(e)
      cancelGesture.current=trackPointer(ruler,e.pointerId,'seek',{move:seek,end:()=>{cancelGesture.current=null}})
      return
    }
    const loop=project.loop,down=beatAt(e.clientX),x=down*ppb
    const gridUnit=dragModifiers(e).noSnap?0:(snapBeats||.25)
    const q=(b:number)=>Math.max(0,gridUnit>0?Math.round(b/gridUnit)*gridUnit:b)
    const minLen=gridUnit||.25
    if(e.shiftKey){
      // ⇧click extends the nearer edge to the pointer and turns the cycle on.
      const b=q(down);let start=loop.startBeat,end=loop.endBeat
      if(b<start)start=b;else if(b>end)end=b;else if(b-start<end-b)start=b;else end=b
      if(end-start<minLen)end=start+minLen
      props.onLoopChange({enabled:true,startBeat:start,endBeat:end});return
    }
    const kind=Math.abs(x-loop.startBeat*ppb)<=6?'start':Math.abs(x-loop.endBeat*ppb)<=6?'end':down>loop.startBeat&&down<loop.endBeat?'move':'create'
    let started=false,draft={start:loop.startBeat,end:loop.endBeat},last:PointerEvent|null=null
    const compute=(event:PointerEvent)=>{
      last=event
      if(!started&&!crossedDragThreshold(event.clientX-e.clientX))return
      if(!started){started=true;ruler.classList.add(kind==='move'?'cycle-grabbing':'cycle-sizing')}
      const box=scroll.getBoundingClientRect();scroller.update(event.clientX,box.top+box.height/2)
      const beat=beatAt(event.clientX)
      if(kind==='move'){const d=q(beat-down);const len=loop.endBeat-loop.startBeat;const start=Math.max(0,loop.startBeat+d);draft={start,end:start+len}}
      else if(kind==='start')draft={start:Math.min(q(beat),loop.endBeat-minLen),end:loop.endBeat}
      else if(kind==='end')draft={start:loop.startBeat,end:Math.max(q(beat),loop.startBeat+minLen)}
      else{const a=gridUnit>0?Math.floor(down/gridUnit)*gridUnit:down,b=q(beat);draft=b>a?{start:a,end:Math.max(b,a+minLen)}:{start:Math.min(b,a),end:a+minLen}}
      setLoopDraft(draft)
    }
    const scroller=edgeScroller(scroll,()=>latest.current.ui.headerWidth,()=>{if(last)compute(last)})
    cancelGesture.current=trackPointer(ruler,e.pointerId,'cycle',{move:compute,end:commit=>{
      scroller.stop();cancelGesture.current=null;setLoopDraft(null);ruler.classList.remove('cycle-grabbing','cycle-sizing')
      if(!commit)return
      if(started)latest.current.onLoopChange({enabled:true,startBeat:draft.start,endBeat:draft.end})
      else latest.current.onLoopChange({...loop,enabled:!loop.enabled})
    }})
  }
  function rulerHover(e:React.PointerEvent<HTMLDivElement>){
    if(e.buttons)return
    const r=e.currentTarget.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,loop=project.loop
    e.currentTarget.style.cursor=y>=CYCLE_BAND?'':Math.abs(x-loop.startBeat*ppb)<=6||Math.abs(x-loop.endBeat*ppb)<=6?'ew-resize':x>loop.startBeat*ppb&&x<loop.endBeat*ppb?'grab':'pointer'
  }

  /** Track reorder from the header background (TrackHeader.onReorderStart). Moves the whole selection when the grabbed track is selected. */
  function beginReorder(e:React.PointerEvent,track:Track){
    if(e.button!==0)return
    cancelGesture.current?.()
    const target=e.currentTarget as HTMLElement,tops=rowTops(),heights=rowHeights(),origin=e.clientY
    const from=rowIndex.get(track.id)??0
    let started=false,index=from
    let moving=new Set([track.id])
    const compute=(event:PointerEvent)=>{
      if(!started&&!crossedDragThreshold(0,event.clientY-origin))return
      if(!started){started=true;const sel=latest.current.selectedTrackIds;if(sel.has(track.id))moving=new Set(sel)}
      const y=sheetPoint(event.clientX,event.clientY).y
      index=tops.findIndex((top,i)=>y<top+heights[i]/2);if(index<0)index=tops.length
      const last=tops.length-1
      setTrackDrop({ids:moving,index,y:index<tops.length?tops[index]:tops[last]+heights[last]})
    }
    cancelGesture.current=trackPointer(target,e.pointerId,'reorder',{move:compute,end:commit=>{
      cancelGesture.current=null;setTrackDrop(null)
      if(!commit||!started)return
      const all=latest.current.project.tracks
      const ids=all.filter(t=>moving.has(t.id)).map(t=>t.id)
      let afterId:string|null=null
      for(let i=index-1;i>=0;i--){if(!moving.has(rows[i].id)){afterId=rows[i].id;break}}
      // Unchanged order: the first moved track already follows afterId.
      const firstMoved=all.findIndex(t=>moving.has(t.id)),prev=firstMoved>0?all[firstMoved-1].id:null
      if(prev===afterId&&ids.length===1)return
      latest.current.onTracksReorder(ids,afterId)
    }})
  }

  /** Individual track height from the header corner; ⌘ changes the shared row height, ⇧ resets. */
  function beginResize(e:React.PointerEvent,track:Track,all:boolean,reset:boolean){
    cancelGesture.current?.()
    if(reset){
      if(all)props.onUiChange({trackZoom:{}})
      else{const next={...ui.trackZoom};delete next[track.id];props.onUiChange({trackZoom:next})}
      return
    }
    const target=e.currentTarget as HTMLElement,startY=e.clientY,startRow=props.zoom.rowHeight,startHeight=heightOf(track)
    cancelGesture.current=trackPointer(target,e.pointerId,'resize',{move:ev=>{
      const dy=ev.clientY-startY
      if(all)latest.current.onZoomChange({rowHeight:clamp(startRow+dy,ZOOM_LIMITS.timelineY.min,ZOOM_LIMITS.timelineY.max)})
      else{const h=clamp(startHeight+dy,ROW_LIMITS.min,ROW_LIMITS.max),f=clamp(h/latest.current.zoom.rowHeight,TRACK_ZOOM_LIMITS.min,TRACK_ZOOM_LIMITS.max);latest.current.onUiChange({trackZoom:{...latest.current.ui.trackZoom,[track.id]:Math.round(f*1000)/1000}})}
    },end:()=>{cancelGesture.current=null}})
  }

  /** Header column width from the header/lane boundary handle. */
  function beginHeaderResize(e:React.PointerEvent<HTMLElement>){
    if(e.button!==0)return
    e.preventDefault();cancelGesture.current?.()
    const startX=e.clientX,startW=headerWidth
    cancelGesture.current=trackPointer(e.currentTarget,e.pointerId,'resize',{move:ev=>latest.current.onUiChange({headerWidth:Math.round(clamp(startW+ev.clientX-startX,HEADER_WIDTH_LIMITS.min,HEADER_WIDTH_LIMITS.max))}),end:()=>{cancelGesture.current=null}})
  }

  /** Marker flag: drag moves (bar grid, ⇧ = beat), click selects and seeks. */
  function beginMarker(e:React.PointerEvent<HTMLElement>,marker:Marker){
    if(e.button!==0||(MAC&&e.ctrlKey))return
    e.stopPropagation();e.preventDefault();cancelGesture.current?.()
    const target=e.currentTarget,startX=e.clientX
    let started=false,beat=marker.startBeat
    cancelGesture.current=trackPointer(target,e.pointerId,'marker',{move:ev=>{
      const dx=ev.clientX-startX
      if(!started&&!crossedDragThreshold(dx))return
      started=true
      const unit=ev.shiftKey?1:4
      beat=Math.max(0,Math.round((marker.startBeat+dx/ppb)/unit)*unit)
      setMarkerDrag({id:marker.id,beat})
    },end:commit=>{
      cancelGesture.current=null;setMarkerDrag(null)
      if(!commit)return
      if(started){if(beat!==marker.startBeat)latest.current.onMarker('move',{id:marker.id,beat})}
      else{setMarkerState({selected:marker.id,renaming:null});latest.current.onSelectClips([],null);latest.current.onSeek(marker.startBeat);pointerFocus(target)}
    }})
  }
  function addMarkerAt(beat:number){const n=latest.current.project.markers.length+1;latest.current.onMarker('add',{beat:Math.max(0,beat),name:`마커 ${n}`})}

  function previewFor(track:Track,clip:Clip):Preview|undefined{
    if(!drag||!drag.ids.has(clip.id))return undefined
    if(drag.mode==='move'){const row=rowIndex.get(track.id)!,moved={...clip,startBeat:clip.startBeat+drag.dBeat};return{start:moved.startBeat,length:moved.lengthBeats,dy:(drag.rowTops[row+drag.dRow]??0)-(drag.rowTops[row]??0),clip:moved,trackId:rows[row+drag.dRow]?.id??track.id}}
    if(drag.mode==='trimEnd'){const trimmed={...clip,lengthBeats:trimEndLength(clip,drag.dBeat)};return{start:trimmed.startBeat,length:trimmed.lengthBeats,dy:0,clip:trimmed,trackId:track.id}}
    const trimmed=trimClipStart(clip,clip.startBeat+drag.dBeat,project.bpm);return{start:trimmed.startBeat,length:trimmed.lengthBeats,dy:0,clip:trimmed,trackId:track.id}
  }
  const clipPreviews=new Map<string,Preview>(),placements=new Map<string,RegionPlacement>()
  if(drag)for(const track of rows)for(const clip of track.clips){const preview=previewFor(track,clip);if(preview){clipPreviews.set(clip.id,preview);placements.set(clip.id,{clip:preview.clip!,trackId:preview.trackId!})}}
  const projected=drag?previewRegionTracks(rows,placements,drag.copy):undefined
  // A copied region needs a temporary distinct ID so its original can stop the new loop.
  if(projected)for(const [id,placement]of projected.placements){const preview=clipPreviews.get(id);if(preview)clipPreviews.set(id,{...preview,clip:placement.clip})}
  const clipActions:ClipActions={beginClipGesture,clipMenu,loopHandle,select:(trackId,clipId)=>props.onSelectClips([clipId],clipId,trackId),open:(trackId,clipId)=>{if(!selectedClipIds.has(clipId))props.onSelectClips([clipId],clipId,trackId);props.onClipOpen?.(trackId,clipId)},renameDone:(clipId,name)=>props.onClipRename?.(clipId,name)}
  const actions=useRef(clipActions);actions.current=clipActions
  const loopView=loopDraft?{startBeat:loopDraft.start,endBeat:loopDraft.end}:project.loop
  const barPx=ppb*4,labelStep=barPx>=40?1:barPx>=20?2:barPx>=10?4:8
  const laneGrid=ppb<8?`${ppb*16}px 100%, ${ppb*4}px 100%`:`${ppb*4}px 100%, ${ppb}px 100%`
  const anyHidden=project.tracks.some(t=>t.hidden),anySolo=project.tracks.some(t=>t.solo)
  const focused=project.tracks.find(t=>t.id===focusedTrackId)
  const multi=selectedTrackIds.size>1
  const markers=project.markers
  const markerBeat=(m:Marker)=>markerDrag?.id===m.id?markerDrag.beat:m.startBeat
  const playheadUi=useRef({catch:ui.catch,scrollInPlay:ui.scrollInPlay,headerWidth});playheadUi.current={catch:ui.catch,scrollInPlay:ui.scrollInPlay,headerWidth}

  return <div className={`arrangement ${fileOver?'file-over':''} ${ui.gridLines?'':'no-grid'}`} data-keyboard-scope="timeline" tabIndex={-1} style={{'--header-width':`${headerWidth}px`} as React.CSSProperties} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href]'))e.currentTarget.focus({preventScroll:true})}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setFileOver(true)}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setFileOver(false)}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();setFileOver(false);props.onAudioDrop(e.dataTransfer.files)}}}>
    <div className="arrangement-title tracks-menubar">
      <div className="menubar-left">
        <button type="button" className="menubar-button" data-menu="edit" aria-haspopup="menu" aria-expanded={menu?.label==='편집'} onClick={e=>barMenu(e,editMenu(),'편집')}>편집 <Icon name="chevron" size={10}/></button>
        <button type="button" className="menubar-button" data-menu="functions" aria-haspopup="menu" aria-expanded={menu?.label==='기능'} onClick={e=>barMenu(e,functionsMenu(),'기능')}>기능 <Icon name="chevron" size={10}/></button>
        <button type="button" className="menubar-button" data-menu="view" aria-haspopup="menu" aria-expanded={menu?.label==='보기'} onClick={e=>barMenu(e,viewMenu(),'보기')}>보기 <Icon name="chevron" size={10}/></button>
        <span className="menubar-divider"/>
        <button type="button" className={`icon-button small follow-toggle catch-toggle ${ui.catch?'active':''}`} aria-pressed={ui.catch} onClick={e=>{props.onUiChange({catch:!ui.catch});if(e.detail)e.currentTarget.blur()}} title={`Catch · 재생 위치 따라가기${ui.scrollInPlay?' (재생 중 스크롤)':''}`} aria-label="재생 위치 따라가기"><Icon name="right" size={14}/></button>
        <span className="menubar-divider"/>
        <button type="button" className={`menubar-button menubar-popup ${ui.snap.on?'':'off'}`} data-menu="snap" aria-haspopup="menu" aria-expanded={menu?.label==='스냅'} onClick={e=>barMenu(e,snapMenu(),'스냅')} title={`스냅 · ${ui.snap.on?SNAP_MODE_LABELS[ui.snap.mode]:'끔'} · ${ui.snap.relative?'상대값':'절대값'}`}><small>Snap:</small> {ui.snap.on?SNAP_MODE_LABELS[ui.snap.mode]:'끔'} <Icon name="chevron" size={10}/></button>
        <button type="button" className="menubar-button menubar-popup" data-menu="drag" aria-haspopup="menu" aria-expanded={menu?.label==='드래그'} onClick={e=>barMenu(e,dragMenu(),'드래그')} title="드래그 모드"><small>Drag:</small> {DRAG_MODE_LABELS[ui.dragMode]} <Icon name="chevron" size={10}/></button>
      </div>
      <div className="arrangement-title-actions"><span className="subtle-count">{project.tracks.length} tracks{multi?` · 트랙 ${selectedTrackIds.size}개`:''}{selectedClipIds.size>1?` · 클립 ${selectedClipIds.size}개 선택`:''}</span><ZoomControls area="어레인지먼트" onZoom={command=>latest.current.onCommand(command)}/></div>
    </div>
    <div className="timeline-body">
    <div className="timeline-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="timeline-sheet" ref={sheetRef} style={{width:width+headerWidth,minWidth:'100%','--row-h':`${rowHeight}px`,'--header-width':`${headerWidth}px`} as React.CSSProperties}>
        <div className="timeline-ruler-row">
          <div className="timeline-corner" role="toolbar" aria-label="트랙 도구">
            <button type="button" className="corner-button" title={`트랙 추가 · 클릭: 새 트랙 창 · ${ALT}클릭: 포커스 트랙과 같은 종류 · ${ALT}⇧: 빈 트랙 · ${MOD}클릭: 다른 종류`} aria-label="트랙 추가" onClick={e=>{const mod=MAC?e.metaKey:e.ctrlKey;if(e.altKey)props.onNewTrack({sameAsFocused:true,empty:e.shiftKey,afterId:focusedTrackId});else if(mod)props.onNewTrack({kind:focused?.kind==='audio'?'instrument':'audio',afterId:focusedTrackId});else props.onNewTrack({dialog:true,afterId:focusedTrackId});if(e.detail)e.currentTarget.blur()}}><Icon name="plus" size={13}/></button>
            <button type="button" className="corner-button" title={`트랙 복제 · 클릭: 설정 복제 (${shortcutLabel('duplicateTrack')}) · ${ALT}클릭: 콘텐츠 포함`} aria-label="트랙 복제" disabled={!focused} onClick={e=>{props.onDuplicateTracks(targetIds(focusedTrackId),e.altKey?'content':'settings');if(e.detail)e.currentTarget.blur()}}><Icon name="copy" size={12}/></button>
            <span className="corner-spacer"/>
            {(anyHidden||ui.hideView)&&<button type="button" className={`corner-button corner-letter ${ui.hideView?'hide-view-on':'hidden-exist'}`} aria-pressed={ui.hideView} title={ui.hideView?'보기 가리기 끄기 (가려진 트랙 표시 중)':'보기 가리기 켜기 (가려진 트랙 있음)'} aria-label="보기 가리기 토글" onClick={e=>{props.onUiChange({hideView:!ui.hideView});if(e.detail)e.currentTarget.blur()}}>H</button>}
            {(anySolo||ui.soloRecall)&&<button type="button" className={`corner-button corner-letter ${anySolo?'solo-on':'solo-recall'}`} title={anySolo?`모든 솔로 해제 (${shortcutLabel('clearRecallSolo')})`:`솔로 복구 (${shortcutLabel('clearRecallSolo')})`} aria-label="솔로 해제/복구" onClick={e=>{props.onClearRecallSolo();if(e.detail)e.currentTarget.blur()}}>S</button>}
            <span className="corner-spacer"/>
            <button type="button" className={`corner-button corner-letter ${ui.globalTracks?'active':''}`} aria-pressed={ui.globalTracks} title={`글로벌 트랙 보기 (${shortcutLabel('globalTracks')})`} aria-label="글로벌 트랙 보기" onClick={e=>{props.onUiChange({globalTracks:!ui.globalTracks});if(e.detail)e.currentTarget.blur()}}>G</button>
            <button type="button" className="corner-button" title={`트랙 헤더 구성 (${shortcutLabel('configureTrackHeader')})`} aria-label="트랙 헤더 구성" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();props.onConfigureHeader({x:r.left,y:r.bottom});if(e.detail)e.currentTarget.blur()}}><Icon name="settings" size={12}/></button>
          </div>
          <div className="timeline-ruler" style={{width}} onPointerDown={e=>beginRuler(e)} onPointerMove={rulerHover} title={`위쪽 띠: 클릭 = 사이클 켬/끔 · 드래그 = 사이클 만들기 · ⇧클릭 = 확장 / 아래: 재생 위치 이동 (${MOD}⇧ = 스냅 무시)`}>
            {Array.from({length:Math.ceil(width/(ppb*4))},(_,i)=><div className="bar-number" key={i} style={{left:i*4*ppb,width:ppb*4}}>{i%labelStep===0?i+1:''}</div>)}
            <div className={`loop-region ${project.loop.enabled||loopDraft?'':'disabled'}`} style={{left:loopView.startBeat*ppb,width:(loopView.endBeat-loopView.startBeat)*ppb}}><span/><span/></div>
            <div className="ruler-playhead" ref={rulerPlayhead} title="드래그하여 재생 위치 이동" onPointerDown={e=>beginRuler(e,e.currentTarget.parentElement as HTMLElement)}><i/></div>
          </div>
        </div>
        {ui.globalTracks&&<div className="timeline-global-row">
          <div className="global-header"><span className="global-name">마커</span><button type="button" className="corner-button" title={`재생 위치에 마커 추가 (${shortcutLabel('createMarker')})`} aria-label="마커 추가" onClick={e=>{addMarkerAt(Math.round(engine.getSnapshot().beat*16)/16);if(e.detail)e.currentTarget.blur()}}><Icon name="plus" size={11}/></button></div>
          <div className="global-lane marker-lane" style={{width,backgroundSize:`${ppb*4}px 100%`}} onDoubleClick={e=>{if(e.target!==e.currentTarget)return;addMarkerAt(Math.floor(laneBeat(e.currentTarget,e.clientX)/4)*4)}} onPointerDown={e=>{if(e.target===e.currentTarget&&e.button===0)setMarkerState({selected:null,renaming:null})}}>
            {markers.map((m,i)=>{const b=markerBeat(m),next=markers[i+1];const end=next?Math.max(b+.5,next.startBeat):Math.max(b+4,contentEnd);const sel=markerState.selected===m.id
              return <div key={m.id} className={`marker ${sel?'selected':''} ${markerDrag?.id===m.id?'dragging':''}`} tabIndex={0} role="button" aria-label={`마커 ${m.name}, ${Math.floor(b/4)+1} 마디`} aria-pressed={sel} style={{left:b*ppb,width:Math.max(12,(end-b)*ppb-1)}} onPointerDown={e=>beginMarker(e,m)} onDoubleClick={e=>{e.stopPropagation();setMarkerState({selected:m.id,renaming:m.id})}} onContextMenu={e=>markerMenu(e,m)} onFocus={()=>{if(markerState.selected!==m.id)setMarkerState(s=>({...s,selected:m.id}))}} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if((e.key==='Delete'||e.key==='Backspace')&&isUnmodified(e.nativeEvent)){e.preventDefault();e.stopPropagation();latest.current.onMarker('delete',{id:m.id})}else if(e.key==='Enter'&&isUnmodified(e.nativeEvent)){e.preventDefault();e.stopPropagation();setMarkerState({selected:m.id,renaming:m.id})}}}>
                <i className="marker-flag"/>{markerState.renaming===m.id?<InlineName value={m.name} label="마커 이름" onDone={name=>{setMarkerState({selected:m.id,renaming:null});if(name!==null)latest.current.onMarker('rename',{id:m.id,name})}}/>:<span className="marker-name">{m.name}</span>}
              </div>})}
            {!markers.length&&<span className="marker-hint">더블 클릭하여 마커 추가</span>}
          </div>
        </div>}
        {rows.map(track=>{const h=heightOf(track),selected=selectedTrackIds.has(track.id),isFocused=track.id===focusedTrackId,enabled=isTrackEnabled(track),silent=!audible.has(track.id)&&enabled,hiddenNow=track.hidden&&ui.hideView
          const cls=['track-row',h<48?'row-compact':h>=110?'row-large':'']
          if(selected)cls.push('selected','selected-track');if(isFocused)cls.push('focused');if(silent)cls.push('track-silent');if(!enabled)cls.push('track-off');if(hiddenNow)cls.push('track-hidden');if(trackDrop?.ids.has(track.id))cls.push('track-dragging')
          return <div className={cls.join(' ')} key={track.id} style={{'--track-color':track.color,'--row-h':`${h}px`,height:h} as React.CSSProperties}>
          <TrackHeader track={track} index={(trackNumber.get(track.id)??1)-1} focused={isFocused} selected={selected} multi={multi} height={h} config={ui.headerConfig} ui={{hideView:ui.hideView,recording:ui.recording}} arm={effectiveArm(track,focusedTrackId,project.tracks)} implicitMute={silent&&!track.mute} renaming={ui.renamingTrackId===track.id} engine={engine}
            onClick={mods=>props.onTrackClick(track.id,mods)} onFocus={()=>props.onTrackFocus(track.id)} onButton={props.onTrackButton} onSweep={props.onTrackSweep} onChange={(patch,key)=>props.onTracksChange([{id:track.id,patch}],key)} onRename={name=>latest.current.onRenameTracks(targetIds(track.id),name)} onOpenLibrary={()=>props.onOpenLibrary(track.id)} onIconMenu={e=>props.onIconMenu(track.id,{x:e.clientX,y:e.clientY})} onContextMenu={e=>trackMenu(e,track)} onReorderStart={e=>beginReorder(e,track)} onResizeStart={(e,all,reset)=>beginResize(e,track,all,reset)}/>
          <div className={`track-lane ${ui.gridLines?'':'no-grid'}`} style={{width,backgroundSize:laneGrid}} onPointerDown={e=>beginMarquee(e,track)} onContextMenu={e=>{if(e.target===e.currentTarget)laneMenu(e,track)}} onDoubleClick={e=>{if(e.target!==e.currentTarget)return;const beat=laneBeat(e.currentTarget,e.clientX);if(e.shiftKey)props.onSeekPlay(beat);else props.onAddClip(track.id,Math.floor(beat/4)*4)}} onDragOver={e=>{if(e.dataTransfer.files||e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();setFileOver(false);const beat=Math.floor(laneBeat(e.currentTarget,e.clientX)/4)*4;props.onAudioDrop(e.dataTransfer.files,track.kind==='audio'?track.id:undefined,Math.max(0,beat))}}}>
            {drag?.copy&&track.clips.filter(c=>drag.ids.has(c.id)).map(c=><div key={`ghost-${c.id}`} className="clip-ghost" style={{left:c.startBeat*ppb,width:c.lengthBeats*ppb-2}}/>)}
            {track.clips.map(clip=><TimelineClip key={clip.id} clip={clip} track={track} asset={clip.kind==='audio'?assets.get(clip.assetId):undefined} ppb={ppb} bpm={project.bpm} projectEnd={project.lengthBeats} selected={marquee?(marquee.ids.has(clip.id)||(marquee.add&&selectedClipIds.has(clip.id))):selectedClipIds.has(clip.id)} preview={clipPreviews.get(clip.id)} occurrenceTrack={projected?.tracks.get(clipPreviews.get(clip.id)?.trackId??track.id)} silent={silent} renaming={props.renamingClipId===clip.id} actions={actions}/>)}
            {!track.clips.length&&<span className="empty-lane-hint">{track.kind==='audio'?'오디오 파일을 여기에 놓으세요':'더블 클릭하여 MIDI 클립 만들기'}</span>}
          </div>
        </div>})}
        <div className="tracks-empty-area" title={`더블 클릭: ${focused?.kind==='audio'?'오디오':'소프트웨어 악기'} 트랙 추가 · 우클릭: 트랙 종류 선택`} onDoubleClick={e=>{if(!(e.target instanceof Element)||e.target.closest('button'))return;props.onNewTrack({sameAsFocused:true,afterId:null})}} onContextMenu={emptyAreaMenu}>
          <div className="empty-header"/><div className="empty-lane" style={{width,backgroundSize:`${ppb*4}px 100%`}}/>
        </div>
        {marquee&&<div className="marquee" style={{left:marquee.x,top:marquee.y,width:marquee.w,height:marquee.h}}/>}
        {trackDrop&&<div className="track-drop-indicator" style={{top:trackDrop.y-1}}/>}
        <Playhead engine={engine} ppb={ppb} scrollRef={scrollRef} uiRef={playheadUi} expectedScroll={expectedScroll} markerRef={rulerPlayhead}/>
      </div>
    </div>
    <div className="header-resize-handle" role="separator" aria-orientation="vertical" aria-label="헤더 너비" title="드래그하여 헤더 너비 조절" onPointerDown={beginHeaderResize} onDoubleClick={()=>props.onUiChange({headerWidth:DEFAULT_HEADER_WIDTH})}/>
    </div>
    {fileOver&&<div className="drop-overlay"><Icon name="wave" size={32}/><strong>오디오를 프로젝트에 추가합니다</strong><span>파일은 이 브라우저에 저장됩니다</span></div>}
    {menu&&<ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} trigger={menu.trigger} onClose={()=>setMenu(null)}/>}
  </div>
}

function Playhead({engine,ppb,scrollRef,uiRef,expectedScroll,markerRef}:{engine:AudioEngine;ppb:number;scrollRef:React.RefObject<HTMLDivElement|null>;uiRef:React.RefObject<{catch:boolean;scrollInPlay:boolean;headerWidth:number}>;expectedScroll:React.RefObject<number|null>;markerRef:React.RefObject<HTMLDivElement|null>}){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{let raf=0,lastBeat=NaN,seeked=false;const frame=()=>{const s=engine.getSnapshot(),x=s.beat*ppb;if(ref.current)ref.current.style.transform=`translateX(${x}px)`;if(markerRef.current)markerRef.current.style.transform=`translateX(${x}px)`
    // Catch: with "scroll in play" the playhead stays centred; otherwise the view flips when the playhead leaves it.
    // A seek (also one made during a gesture) catches once no gesture is active.
    if(Number.isFinite(lastBeat)&&s.beat!==lastBeat)seeked=true
    lastBeat=s.beat
    const scroll=scrollRef.current,ui=uiRef.current
    if(scroll&&!document.querySelector('[data-daw-gesture]')){
      const visible=scroll.clientWidth-ui.headerWidth
      if(ui.catch&&(s.playing||seeked)&&visible>40){
        if(ui.scrollInPlay&&s.playing){const target=Math.max(0,x-visible*.5);if(Math.abs(scroll.scrollLeft-target)>=.5){expectedScroll.current=target;scroll.scrollLeft=target}}
        else if(x<scroll.scrollLeft||x>scroll.scrollLeft+visible-8){const target=Math.max(0,x);expectedScroll.current=target;scroll.scrollLeft=target}
      }
      seeked=false
    }
    raf=requestAnimationFrame(frame)};frame();return()=>cancelAnimationFrame(raf)},[engine,ppb,scrollRef,uiRef,expectedScroll,markerRef])
  return <div className="playhead" ref={ref}><i/></div>
}
export function MiniMeter({engine,trackId,color='#9fcfb4',vertical=false}:{engine:AudioEngine;trackId?:string;color?:string;vertical?:boolean}){
  const ref=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{let raf=0;let held=0;let last=0;const frame=(now:number)=>{if(now-last>33){last=now;const c=ref.current;const ctx=c?.getContext('2d');if(c&&ctx){const value=trackId?engine.getTrackLevel(trackId):engine.getMasterLevel();held=Math.max(value,held*.88);const fill=Math.min(1,Math.sqrt(held)*1.6);ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#2d2a25';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle=held>.85?'#e5533d':color;if(vertical)ctx.fillRect(0,c.height*(1-fill),c.width,c.height*fill);else ctx.fillRect(0,0,c.width*fill,c.height)}}raf=requestAnimationFrame(frame)};raf=requestAnimationFrame(frame);return()=>cancelAnimationFrame(raf)},[engine,trackId,color,vertical])
  return <canvas ref={ref} width={vertical?5:38} height={vertical?120:4} className={vertical?'meter-vertical':'mini-meter'} aria-label="실시간 오디오 레벨"/>
}
