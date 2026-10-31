import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentProps, InputHTMLAttributes } from 'react'
import { WebAudioEngine } from './audio/WebAudioEngine'
import type { AudioAsset, AudioClip, Clip, EffectType, InstrumentId, MidiClip, Project, Track } from './core/types'
import { createDemoProject, createDevice, createEmptyProject, createTrack, defaultInstrumentParams, duplicateClip, duplicateTrack, fitProjectLength, joinClips, moveDevice, splitClip, transposeClip, trimClipEnd, trimClipStart, uid } from './core/project'
import { EFFECT_DEFS } from './core/devices'
import { INSTRUMENTS, INSTRUMENT_SECTIONS, SAMPLE_CREDITS, instrumentDef, previewPitch } from './core/instruments'
import { exportProjectBundle, importProjectBundle, loadProject, saveProject } from './core/storage'
import { Icon } from './components/Icon'
import { Brand } from './components/Brand'
import { BRAND, SOURCE_REPOSITORY_URL } from './brand'
import { Timeline, MiniMeter, HEADER_WIDTH, MAX_PPB, MIN_PPB, TRACK_COLORS, type ClipEdit, type RenameTarget } from './components/Timeline'
import PianoRoll from './components/PianoRoll'
import Mixer from './components/Mixer'
import { Waveform } from './components/Waveform'
import { DeviceChain } from './components/DeviceChain'
import { InstrumentOptions } from './components/InstrumentOptions'
import { SHORTCUT_TABLE, ZOOM_COMMANDS, isShortcutSuppressed, isUnmodified, resolveProjectShortcut, shortcutLabel, shortcutPlatform, shortcutScope, type ProjectShortcut, type ShortcutScope } from './core/input'
import { DEVICE_KEY_FACTOR, ZOOM_KEY_FACTOR, ZOOM_KEY_FACTOR_V, ZOOM_LIMITS, clampZoom, fitScale, loadZoom, saveZoom, zoomBy, type ZoomCommand, type ZoomHandle, type ZoomState } from './core/zoom'
import { useZoomWheel } from './components/useZoomWheel'
import { ZoomControls } from './components/ZoomControls'

// An application-session service, independent of React's render/effect lifecycle.
const engine = new WebAudioEngine()
const subscribeTransport = (cb:()=>void)=>engine.subscribe(cb)
const readTransport = ()=>engine.getSnapshot()
if(import.meta.hot)import.meta.hot.dispose(()=>engine.dispose())

type History={past:Project[];present:Project;future:Project[]}
type Action={type:'edit';edit:(p:Project)=>Project;merge:boolean}|{type:'undo'|'redo'}|{type:'reset';project:Project}
function historyReducer(s:History,a:Action):History{
  if(a.type==='reset')return{past:[],present:a.project,future:[]}
  if(a.type==='undo'){const previous=s.past.at(-1);return previous?{past:s.past.slice(0,-1),present:previous,future:[s.present,...s.future]}:s}
  if(a.type==='redo'){const next=s.future[0];return next?{past:[...s.past,s.present],present:next,future:s.future.slice(1)}:s}
  if(a.type==='edit'){const next=a.edit(s.present);if(next===s.present)return s;return{past:a.merge?s.past:[...s.past.slice(-49),s.present],present:next,future:[]}}
  return s
}
function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000)}
const safeFilename=(name:string)=>name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim()||'Untitled'
const db=(n:number)=>n<=0?'−∞':(20*Math.log10(n)).toFixed(1)
type ClipEntry={clip:Clip;track:Track;row:number}
type Clipboard={items:{clip:Clip;row:number;kind:Track['kind']}[];base:number;topRow:number}
/** Replaces the listed clips (null removes, an array splits) and keeps untouched tracks' identity. */
function mapClips(p:Project,ids:ReadonlySet<string>,fn:(clip:Clip,track:Track)=>Clip|Clip[]|null):Project{
  let changed=false
  const tracks=p.tracks.map(t=>{if(!t.clips.some(c=>ids.has(c.id)))return t;changed=true;return{...t,clips:t.clips.flatMap(c=>{if(!ids.has(c.id))return[c];const r=fn(c,t);return r===null?[]:Array.isArray(r)?r:[r]})}})
  return changed?{...p,tracks}:p
}
const addClips=(p:Project,additions:{trackId:string;clip:Clip}[]):Project=>({...p,tracks:p.tracks.map(t=>{const add=additions.filter(a=>a.trackId===t.id).map(a=>a.clip);return add.length?{...t,clips:[...t.clips,...add]}:t})})
const shortcutText=(command:ProjectShortcut)=>shortcutLabel(command)
const SCOPE_GROUPS:[string,string][]=[['timeline,piano,workspace','어디서나'],['timeline,workspace','타임라인·작업 공간'],['timeline,piano','타임라인·피아노롤'],['timeline','타임라인'],['piano','피아노롤'],['workspace','작업 공간']]

export default function App(){
  const [history,dispatch]=useReducer(historyReducer,undefined,()=>({past:[],present:createDemoProject(),future:[]}))
  const project=history.present
  const [assets,setAssets]=useState<Map<string,AudioAsset>>(new Map())
  const [selectedTrackId,setSelectedTrackId]=useState(project.tracks[2]?.id??project.tracks[0]?.id??'')
  const [selectedClipIds,setSelectedClipIds]=useState<ReadonlySet<string>>(()=>new Set(project.tracks[2]?.clips[0]?[project.tracks[2].clips[0].id]:[]))
  const [anchorClipId,setAnchorClipId]=useState<string|null>(project.tracks[2]?.clips[0]?.id??null)
  const [renaming,setRenaming]=useState<RenameTarget|null>(null)
  const [pendingDeleteTrack,setPendingDeleteTrack]=useState<string|null>(null)
  const clipboard=useRef<Clipboard|null>(null)
  const lastSnap=useRef(.25)
  const [bottomTab,setBottomTab]=useState<'editor'|'mixer'|'devices'>('editor')
  const [browserTab,setBrowserTab]=useState<'instruments'|'files'>('instruments')
  const [search,setSearch]=useState('')
  const [zoom,setZoom]=useState<ZoomState>(()=>loadZoom())
  const initialZoom=useRef(zoom)
  const pianoZoom=useRef<ZoomHandle|null>(null),mixerZoom=useRef<ZoomHandle|null>(null),deviceZoom=useRef<ZoomHandle|null>(null)
  const browserRef=useRef<HTMLElement>(null)
  const lastFit=useRef<{ppb:number;kind:'selection'|'all'}|null>(null)
  const patchZoom=useCallback(<K extends keyof ZoomState>(area:K,patch:(z:ZoomState[K])=>Partial<ZoomState[K]>)=>setZoom(z=>({...z,[area]:{...z[area],...patch(z[area])}})),[])
  const ppb=zoom.timeline.ppb
  const setPpb=useCallback((value:number)=>patchZoom('timeline',()=>({ppb:clampZoom(value,ZOOM_LIMITS.timelineX)})),[patchZoom])
  const setRowHeight=useCallback((value:number)=>patchZoom('timeline',()=>({rowHeight:clampZoom(value,ZOOM_LIMITS.timelineY)})),[patchZoom])
  useEffect(()=>{if(zoom===initialZoom.current)return;const id=window.setTimeout(()=>saveZoom(zoom),250);return()=>clearTimeout(id)},[zoom])
  const [snap,setSnap]=useState(.25)
  const [browserOpen,setBrowserOpen]=useState(true)
  const [inspectorOpen,setInspectorOpen]=useState(true)
  // Ctrl/⌘ + wheel over the browser switches between compact and comfortable rows.
  useZoomWheel(browserRef,{onZoomX:factor=>patchZoom('browser',()=>({compact:factor<1})),onZoomY:factor=>patchZoom('browser',()=>({compact:factor<1}))},browserOpen)
  const [loaded,setLoaded]=useState(false)
  const [restoreError,setRestoreError]=useState('')
  const projectSession=useRef(0)
  const importing=useRef(false)
  const [saveStatus,setSaveStatus]=useState<'loading'|'saving'|'saved'|'error'>('loading')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState('')
  const [modal,setModal]=useState<'new'|'export'|'help'|'about'|'deleteTrack'|null>(null)
  const [recording,setRecording]=useState(false)
  const [recordPreparing,setRecordPreparing]=useState(false)
  const audioInput=useRef<HTMLInputElement>(null)
  const projectInput=useRef<HTMLInputElement>(null)
  const recordRef=useRef<{recorder:MediaRecorder;stream:MediaStream}|null>(null)
  const recordTarget=useRef<{trackId?:string;beat?:number}>({})
  const saveQueue=useRef(Promise.resolve())
  const saveRevision=useRef(0)
  const lastEdit=useRef({key:'',time:0})
  const selectedTrack=project.tracks.find(t=>t.id===selectedTrackId)
  const clipIndex=useMemo(()=>{const map=new Map<string,ClipEntry>();project.tracks.forEach((track,row)=>track.clips.forEach(clip=>map.set(clip.id,{clip,track,row})));return map},[project])
  const anchorEntry=anchorClipId?clipIndex.get(anchorClipId):undefined
  // The anchor (last selected clip) drives the editor and inspector; the set drives edits.
  const selectedClip=anchorEntry&&anchorEntry.track.id===selectedTrackId?anchorEntry.clip:undefined
  const selection=[...selectedClipIds].map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e).sort((a,b)=>a.clip.startBeat-b.clip.startBeat||a.row-b.row)
  const selectedInstrument=selectedTrack?instrumentDef(selectedTrack.instrument):undefined
  const foundInstruments=INSTRUMENTS.filter(i=>(i.name+i.nameKo+i.description).toLowerCase().includes(search.toLowerCase()))

  const notify=useCallback((message:string)=>setNotice(message),[])
  const commit=useCallback((edit:(p:Project)=>Project,key='')=>{
    const now=performance.now();const merge=!!key&&lastEdit.current.key===key&&now-lastEdit.current.time<450
    lastEdit.current={key,time:now};dispatch({type:'edit',edit,merge})
  },[])
  const breakHistoryMerge=useCallback(()=>{lastEdit.current={key:'',time:0}},[])
  const changeHistory=useCallback((type:'undo'|'redo')=>{breakHistoryMerge();dispatch({type})},[breakHistoryMerge])
  const changeTrack=useCallback((id:string,patch:Partial<Track>)=>commit(p=>({...p,tracks:p.tracks.map(t=>t.id===id?{...t,...patch}:t)}),`${id}:${Object.keys(patch).join(',')}`),[commit])
  const editTrack=useCallback((id:string,edit:(t:Track)=>Track,key='')=>commit(p=>({...p,tracks:p.tracks.map(t=>t.id===id?edit(t):t)}),key),[commit])
  const changeInstrument=(id:string,instrument:InstrumentId)=>changeTrack(id,{instrument,instrumentParams:defaultInstrumentParams(instrument)})
  const toggleDevice=(id:string,deviceId:string)=>editTrack(id,t=>({...t,devices:t.devices.map(d=>d.id===deviceId?{...d,enabled:!d.enabled}:d)}))
  function addDevice(id:string,type:EffectType){const device=createDevice(type);editTrack(id,t=>({...t,devices:[...t.devices,device]}))}
  function previewTrack(track:Track){void engine.previewNote(track.instrument,previewPitch(instrumentDef(track.instrument)),.8,track.id).catch(e=>notify(String(e)))}
  function changeClip(clip:Clip,key=''){commit(p=>mapClips(p,new Set([clip.id]),()=>clip),key)}
  function selectClips(ids:string[],trackId:string,anchor:string|null=ids.at(-1)??null){breakHistoryMerge();setSelectedClipIds(new Set(ids));setAnchorClipId(anchor);setSelectedTrackId(trackId)}
  /** Click selects only this clip; add extends the set; toggle removes an already selected clip. */
  function select(trackId:string,clipId?:string,opts:{add?:boolean;toggle?:boolean}={}){
    breakHistoryMerge();setSelectedTrackId(trackId)
    if(!clipId){if(!opts.add){setSelectedClipIds(new Set());setAnchorClipId(null)}return}
    if(opts.toggle&&selectedClipIds.has(clipId)){const rest=[...selectedClipIds].filter(id=>id!==clipId);const anchor=rest.at(-1)??null;setSelectedClipIds(new Set(rest));setAnchorClipId(anchor);const owner=anchor?clipIndex.get(anchor)?.track.id:undefined;if(owner)setSelectedTrackId(owner);return}
    setSelectedClipIds(opts.add||opts.toggle?new Set([...selectedClipIds,clipId]):new Set([clipId]));setAnchorClipId(clipId)
  }
  function openClip(trackId:string,clipId:string){select(trackId,clipId);setBottomTab('editor')}
  function selectTrack(trackId:string){const track=project.tracks.find(t=>t.id===trackId);if(!track)return;const ids=track.clips.map(c=>c.id);const first=[...track.clips].sort((a,b)=>a.startBeat-b.startBeat)[0]?.id??null;selectClips(ids,trackId,anchorClipId&&ids.includes(anchorClipId)?anchorClipId:first)}
  function selectFromMarquee(ids:string[],add:boolean){const all=add?[...new Set([...selectedClipIds,...ids])]:ids;const anchor=anchorClipId&&all.includes(anchorClipId)?anchorClipId:ids.map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e).sort((a,b)=>a.row-b.row||a.clip.startBeat-b.clip.startBeat)[0]?.clip.id??null;selectClips(all,(anchor&&clipIndex.get(anchor)?.track.id)||selectedTrackId,anchor)}
  // Undo/redo or deletion can remove selected clips: drop them, move the anchor, keep the track valid.
  useEffect(()=>{
    const ids=[...selectedClipIds].filter(id=>clipIndex.has(id))
    if(ids.length!==selectedClipIds.size)setSelectedClipIds(new Set(ids))
    let anchor=anchorClipId
    if(anchor&&!clipIndex.has(anchor)){anchor=ids.at(-1)??null;setAnchorClipId(anchor)}
    const owner=anchor?clipIndex.get(anchor)?.track.id:undefined
    if(owner&&owner!==selectedTrackId)setSelectedTrackId(owner)
    else if(!owner&&!project.tracks.some(t=>t.id===selectedTrackId))setSelectedTrackId(project.tracks[0]?.id??'')
    if(renaming&&!(renaming.kind==='clip'?clipIndex.has(renaming.id):project.tracks.some(t=>t.id===renaming.id)))setRenaming(null)
  },[clipIndex])

  useEffect(()=>{engine.setProject(project)},[project])
  useEffect(()=>{engine.setAssets(assets)},[assets])
  useEffect(()=>{
    let cancelled=false
    void(async()=>{try{const saved=await loadProject();if(cancelled)return;if(saved){const decoded=await Promise.all(saved.assets.map(a=>engine.decodeAsset(a.blob,a.name,a.id)));if(cancelled)return;const next=new Map(decoded.map(a=>[a.id,a]));engine.setAssets(next);setAssets(next);breakHistoryMerge();dispatch({type:'reset',project:saved.project});const first=saved.project.tracks[0];selectClips(first?.clips[0]?[first.clips[0].id]:[],first?.id??'')}if(!cancelled)setLoaded(true)}catch(error){if(!cancelled){setRestoreError(error instanceof Error?error.message:'저장소 오류');setSaveStatus('error')}}})()
    return()=>{cancelled=true}
  },[notify])
  useEffect(()=>{
    if(!loaded)return
    const revision=++saveRevision.current;setSaveStatus('saving')
    const timer=window.setTimeout(()=>{saveQueue.current=saveQueue.current.catch(()=>{}).then(async()=>{try{await saveProject(project,assets);if(saveRevision.current===revision)setSaveStatus('saved')}catch(error){if(saveRevision.current===revision){setSaveStatus('error');notify(`자동 저장 실패: ${error instanceof Error?error.message:'저장 공간을 확인해주세요'}. 프로젝트 파일을 내려받아 보관해주세요.`)}}})},650)
    return()=>window.clearTimeout(timer)
  },[project,assets,loaded,notify])
  useEffect(()=>{if(!notice)return;const id=window.setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(id)},[notice])
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(loaded&&(saveStatus!=='saved'||recording||recordPreparing||busy)){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[loaded,saveStatus,recording,recordPreparing,busy])
  useEffect(()=>{const hide=()=>{engine.pause();if(recordRef.current?.recorder.state==='recording')recordRef.current.recorder.stop()};window.addEventListener('pagehide',hide);return()=>window.removeEventListener('pagehide',hide)},[])

  async function togglePlayback(){try{if(engine.getSnapshot().playing)engine.pause();else await engine.play()}catch(e){notify(`오디오를 시작할 수 없습니다: ${e instanceof Error?e.message:''}`)}}
  function stop(){if(recordRef.current?.recorder.state==='recording')recordRef.current.recorder.stop();engine.stop()}
  function addTrack(kind:'instrument'|'audio'='instrument',instrument:InstrumentId='keys'){
    const track=createTrack(kind,instrument);commit(p=>({...p,tracks:[...p.tracks,track]}));select(track.id);return track
  }
  function addMidiClip(trackId:string,beat:number){
    const track=project.tracks.find(t=>t.id===trackId);if(!track)return
    if(track.kind==='audio'){recordTarget.current={trackId,beat};audioInput.current?.click();return}
    const clip:MidiClip={kind:'midi',id:uid(),name:'새 패턴',startBeat:Math.max(0,beat),lengthBeats:8,gain:1,notes:[]}
    commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,beat+8),tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:[...t.clips,clip]}:t)}));openClip(trackId,clip.id)
  }
  const playhead=()=>engine.getSnapshot().beat
  const audioMax=(clip:Clip)=>{if(clip.kind!=='audio')return Infinity;const asset=assets.get(clip.assetId);return asset?Math.max(.0625,(asset.buffer.duration-clip.offsetSeconds)*project.bpm/60):Infinity}
  const idsOf=(entries:ClipEntry[])=>new Set(entries.map(e=>e.clip.id))
  const selectionStart=()=>Math.min(...selection.map(e=>e.clip.startBeat))
  const selectionEnd=()=>Math.max(...selection.map(e=>e.clip.startBeat+e.clip.lengthBeats))
  // Clip commands derive the next project from the rendered one, so IDs generated here
  // stay identical when StrictMode replays the reducer.
  function apply(next:Project,key=''){if(next!==project)commit(()=>fitProjectLength(next),key)}
  function requireSelection(message='먼저 클립을 선택해주세요.'){if(selection.length)return true;notify(message);return false}
  function selectNew(made:{trackId:string;clip:Clip;from?:string}[]){if(!made.length)return;const anchor=made.find(m=>m.from!==undefined&&m.from===anchorClipId)??made.at(-1)!;selectClips(made.map(m=>m.clip.id),anchor.trackId,anchor.clip.id)}
  function editSelection(fn:(clip:Clip)=>Clip,filter:(e:ClipEntry)=>boolean=()=>true,empty='먼저 클립을 선택해주세요.',key=''){const targets=selection.filter(filter);if(!targets.length){notify(empty);return}apply(mapClips(project,idsOf(targets),fn),key)}
  function applyClipEdit(edit:ClipEdit){
    const entries=edit.ids.map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e);if(!entries.length)return
    const set=idsOf(entries)
    if(edit.mode!=='move'){const d=edit.dBeat;apply(mapClips(project,set,c=>edit.mode==='trimEnd'?trimClipEnd(c,c.startBeat+c.lengthBeats+d,audioMax(c)):trimClipStart(c,c.startBeat+d,project.bpm)));return}
    const {dRow,dBeat,copy}=edit
    const moved=entries.map(e=>{const target=project.tracks[e.row+dRow];const startBeat=Math.max(0,e.clip.startBeat+dBeat);return{from:e.clip.id,target,source:e.track,clip:copy?duplicateClip(e.clip,startBeat):{...e.clip,startBeat}}})
    if(moved.some(m=>!m.target||m.target.kind!==m.source.kind))return
    apply(addClips(copy?project:mapClips(project,set,()=>null),moved.map(m=>({trackId:m.target.id,clip:m.clip}))))
    if(copy)selectNew(moved.map(m=>({trackId:m.target.id,clip:m.clip,from:m.from})))
    else{const a=moved.find(m=>m.from===anchorClipId);if(a)setSelectedTrackId(a.target.id)}
  }
  function deleteSelectedClips(){if(!selection.length)return;apply(mapClips(project,idsOf(selection),()=>null));breakHistoryMerge();setSelectedClipIds(new Set());setAnchorClipId(null)}
  function copySelection(){if(!requireSelection('복사할 클립을 선택해주세요.'))return false;clipboard.current={items:selection.map(e=>({clip:e.clip,row:e.row,kind:e.track.kind})),base:selectionStart(),topRow:Math.min(...selection.map(e=>e.row))};return true}
  /** Pastes at the playhead (or the clicked beat), keeping relative timing and track offsets when the kinds match. */
  function paste(ctx:{trackId?:string;beat?:number}={}){
    const board=clipboard.current;if(!board?.items.length){notify('붙여넣을 클립이 없습니다. 먼저 복사해주세요.');return}
    const targetRow=project.tracks.findIndex(t=>t.id===(ctx.trackId??selectedTrackId));if(targetRow<0){notify('붙여넣을 트랙을 선택해주세요.');return}
    const beat=Math.max(0,ctx.beat??playhead()),made:{trackId:string;clip:Clip}[]=[]
    for(const item of board.items){let track=project.tracks[targetRow+item.row-board.topRow];if(!track||track.kind!==item.kind)track=project.tracks[targetRow];if(track.kind!==item.kind)continue;made.push({trackId:track.id,clip:duplicateClip(item.clip,beat+item.clip.startBeat-board.base)})}
    if(!made.length){notify(`${board.items[0].kind==='audio'?'오디오':'MIDI'} 클립은 같은 종류의 트랙에만 붙여넣을 수 있습니다.`);return}
    apply(addClips(project,made));selectNew(made)
  }
  function duplicateSelection(){if(!requireSelection('복제할 클립을 선택해주세요.'))return;const span=selectionEnd()-selectionStart();const made=selection.map(e=>({trackId:e.track.id,clip:duplicateClip(e.clip,e.clip.startBeat+span),from:e.clip.id}));apply(addClips(project,made));selectNew(made)}
  function splitSelection(){
    const beat=playhead(),candidates=selection.length?selection:(selectedTrack?.clips??[]).map(c=>clipIndex.get(c.id)).filter((e):e is ClipEntry=>!!e)
    const parts=new Map<string,{trackId:string;clips:Clip[]}>()
    for(const e of candidates){const r=splitClip(e.clip,beat,project.bpm);if(r.length===2)parts.set(e.clip.id,{trackId:e.track.id,clips:r})}
    if(!parts.size){notify('재생 커서가 지나가는 클립을 선택한 뒤 분할해주세요.');return}
    apply(mapClips(project,new Set(parts.keys()),c=>parts.get(c.id)!.clips))
    selectNew([...parts.entries()].map(([from,v])=>({trackId:v.trackId,clip:v.clips[1],from})))
  }
  function joinSelection(){
    if(selection.length<2||new Set(selection.map(e=>e.track.id)).size>1){notify('같은 트랙에서 합칠 클립을 두 개 이상 선택해주세요.');return}
    const joined=joinClips(selection.map(e=>e.clip),project.bpm)
    if(!joined){notify('같은 오디오 파일에서 끊김 없이 이어지는 클립만 합칠 수 있습니다.');return}
    apply(mapClips(project,idsOf(selection),c=>c.id===joined.id?joined:null));selectClips([joined.id],selection[0].track.id,joined.id)
  }
  function selectAll(){const own=selectedTrack?.clips.map(c=>c.id)??[];const ids=own.length&&!(selectedClipIds.size===own.length&&own.every(id=>selectedClipIds.has(id)))?own:[...clipIndex.keys()];if(!ids.length)return;const anchor=anchorClipId&&ids.includes(anchorClipId)?anchorClipId:ids[0];selectClips(ids,clipIndex.get(anchor)?.track.id??selectedTrackId,anchor)}
  function selectAdjacent(dir:1|-1){
    const track=anchorEntry?.track??selectedTrack;if(!track?.clips.length)return
    const sorted=[...track.clips].sort((a,b)=>a.startBeat-b.startBeat),i=anchorEntry?sorted.findIndex(c=>c.id===anchorEntry.clip.id):-1,beat=playhead()
    const next=i>=0?sorted[i+dir]:dir>0?sorted.find(c=>c.startBeat>=beat)??sorted[0]:[...sorted].reverse().find(c=>c.startBeat<beat)??sorted.at(-1)
    if(next)select(track.id,next.id)
  }
  function selectAdjacentTrack(dir:1|-1){const i=project.tracks.findIndex(t=>t.id===selectedTrackId);const next=project.tracks[i<0?0:i+dir];if(next)select(next.id)}
  function changeLoop(start:number,end:number,enabled:boolean){const startBeat=Math.max(0,start),endBeat=Math.max(startBeat+.25,end);commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil(endBeat/4)*4),loop:{enabled,startBeat,endBeat}}))}
  /** Logic's Z: fit the selection; pressed again on that view (or without a selection), fit the whole project. Tracks shrink to fit vertically when they would scroll. */
  function zoomToFit(){
    const scroll=document.querySelector<HTMLElement>('.timeline-scroll');if(!scroll)return
    const fitSelection=selection.length>0&&!(lastFit.current?.kind==='selection'&&Math.abs(lastFit.current.ppb-ppb)<.01)
    const start=fitSelection?selectionStart():0,end=fitSelection?selectionEnd():Math.max(project.lengthBeats,...project.tracks.flatMap(t=>t.clips.map(c=>c.startBeat+c.lengthBeats)))
    const next=fitScale(Math.max(1,end-start),scroll.clientWidth-HEADER_WIDTH-24,{min:MIN_PPB,max:MAX_PPB})
    const rows=Math.max(1,project.tracks.length),available=scroll.clientHeight-38-49-32,rowHeight=zoom.timeline.rowHeight
    const fitRow=rows*rowHeight>available?Math.max(ZOOM_LIMITS.timelineY.min,Math.floor(available/rows)):rowHeight
    lastFit.current={ppb:next,kind:fitSelection?'selection':'all'}
    patchZoom('timeline',()=>({ppb:next,rowHeight:fitRow}));requestAnimationFrame(()=>{scroll.scrollLeft=Math.max(0,start*next-8);if(fitRow!==rowHeight)scroll.scrollTop=0})
  }
  /** Zoom keys and buttons act on the area with key focus; with nothing focused, the arrangement. */
  function zoomArea(command:ZoomCommand,scope?:ShortcutScope){
    const horizontal=command==='zoomIn'||command==='zoomOut',zoomIn=command==='zoomIn'||command==='zoomInV'
    const factor=(horizontal?ZOOM_KEY_FACTOR:ZOOM_KEY_FACTOR_V)**(zoomIn?1:-1)
    const handle=scope==='piano'?pianoZoom.current:scope==='mixer'?mixerZoom.current:scope==='devices'?deviceZoom.current:null
    if(scope==='devices'&&handle){if(command==='zoomToFit')handle.fit();else handle.zoom('x',DEVICE_KEY_FACTOR**(zoomIn?1:-1));return}
    if(handle){if(command==='zoomToFit')handle.fit();else handle.zoom(horizontal?'x':'y',factor);return}
    if(command==='zoomToFit')zoomToFit()
    else if(horizontal)setPpb(zoomBy(ppb,factor,ZOOM_LIMITS.timelineX))
    else setRowHeight(zoomBy(zoom.timeline.rowHeight,factor,ZOOM_LIMITS.timelineY))
  }
  function requestDeleteTrack(id:string){if(!project.tracks.some(t=>t.id===id))return;setPendingDeleteTrack(id);setModal('deleteTrack')}
  function confirmDeleteTrack(){
    const index=project.tracks.findIndex(t=>t.id===pendingDeleteTrack);setModal(null);setPendingDeleteTrack(null);if(index<0)return
    const id=project.tracks[index].id,neighbor=project.tracks[index+1]??project.tracks[index-1]
    commit(p=>({...p,tracks:p.tracks.filter(t=>t.id!==id)}));select(neighbor?.id??'')
  }
  function moveTrack(id:string,to:number){commit(p=>{const from=p.tracks.findIndex(t=>t.id===id);const target=Math.max(0,Math.min(p.tracks.length-1,to));if(from<0||target===from)return p;const tracks=[...p.tracks];const [track]=tracks.splice(from,1);tracks.splice(target,0,track);return{...p,tracks}})}
  function trackAction(id:string,action:'duplicate'|'delete'|'up'|'down'){
    const index=project.tracks.findIndex(t=>t.id===id);if(index<0)return
    if(action==='delete')requestDeleteTrack(id)
    else if(action==='up'||action==='down')moveTrack(id,index+(action==='up'?-1:1))
    else{const copy=duplicateTrack(project.tracks[index]);commit(p=>{const at=p.tracks.findIndex(t=>t.id===id);const tracks=[...p.tracks];tracks.splice(at+1,0,copy);return{...p,tracks}});select(copy.id)}
  }
  async function playFromSelection(){if(selection.length)engine.seek(selectionStart());if(!engine.getSnapshot().playing)await togglePlayback()}
  // Inside the piano roll these keys belong to note editing; the app never turns them into clip edits.
  const PIANO_OWNED=new Set<ProjectShortcut>(['copy','cut','paste','selectAll','nudgeLeft','nudgeRight','trimEndLeft','trimEndRight','transposeUp','transposeDown','transposeOctaveUp','transposeOctaveDown','deleteNotes','quantize'])
  function run(command:ProjectShortcut,ctx:{trackId?:string;beat?:number;scope?:ShortcutScope}={}){
    if(ctx.scope==='piano'&&PIANO_OWNED.has(command))return
    const step=snap||.25,beat=playhead()
    switch(command){
      case 'playback':void togglePlayback();break
      case 'playFromSelection':void playFromSelection();break
      case 'undo':changeHistory('undo');break
      case 'redo':changeHistory('redo');break
      case 'save':void saveBundle();break
      case 'home':engine.seek(0);break
      case 'rewind':engine.seek(Math.max(0,Math.ceil(beat/4-1e-6)*4-4));break
      case 'forward':engine.seek(Math.min(project.lengthBeats,Math.floor(beat/4+1e-6)*4+4));break
      case 'escape':setRenaming(null);breakHistoryMerge();setSelectedClipIds(new Set());setAnchorClipId(null);break
      case 'help':setModal('help');break
      case 'cycle':commit(p=>({...p,loop:{...p.loop,enabled:!p.loop.enabled}}));break
      case 'record':void toggleRecord();break
      case 'metronome':notify('메트로놈은 아직 오디오 엔진에 없습니다. 곧 지원됩니다.');break
      case 'snapToggle':if(snap>0){lastSnap.current=snap;setSnap(0)}else setSnap(lastSnap.current||.25);break
      case 'zoomIn':case 'zoomOut':case 'zoomInV':case 'zoomOutV':case 'zoomToFit':zoomArea(command,ctx.scope);break
      case 'setLoopFromSelection':if(requireSelection('반복 구간으로 지정할 클립을 선택해주세요.')){const start=Math.floor(selectionStart()/4)*4;changeLoop(start,Math.max(start+4,Math.ceil(selectionEnd()/4)*4),true)}break
      case 'deleteClip':deleteSelectedClips();break
      case 'split':splitSelection();break
      case 'join':joinSelection();break
      case 'duplicate':case 'repeat':duplicateSelection();break
      case 'copy':copySelection();break
      case 'cut':if(copySelection())deleteSelectedClips();break
      case 'paste':paste(ctx);break
      case 'selectAll':selectAll();break
      case 'loopClip':notify('클립 루프는 곧 지원됩니다.');break
      case 'muteClip':{const mute=selection.some(e=>!e.clip.mute);editSelection(c=>({...c,mute}),undefined,'뮤트할 클립을 선택해주세요.');break}
      case 'renameClip':if(anchorEntry){setRenaming({kind:'clip',id:anchorEntry.clip.id})}else notify('이름을 바꿀 클립을 선택해주세요.');break
      case 'moveToPlayhead':if(requireSelection()){const d=beat-selectionStart();editSelection(c=>({...c,startBeat:Math.max(0,c.startBeat+d)}))}break
      case 'selectPrev':selectAdjacent(-1);break
      case 'selectNext':selectAdjacent(1);break
      case 'nudgeLeft':case 'nudgeRight':if(requireSelection()){const d=Math.max(-selectionStart(),command==='nudgeLeft'?-step:step);if(d)editSelection(c=>({...c,startBeat:c.startBeat+d}))}break
      case 'trimEndLeft':case 'trimEndRight':{const d=command==='trimEndLeft'?-step:step;editSelection(c=>trimClipEnd(c,c.startBeat+c.lengthBeats+d,audioMax(c)));break}
      case 'trimStartToPlayhead':if(requireSelection())editSelection(c=>trimClipStart(c,beat,project.bpm),e=>beat<e.clip.startBeat+e.clip.lengthBeats,'재생 커서가 선택 클립의 끝보다 앞에 있어야 합니다.');break
      case 'trimEndToPlayhead':if(requireSelection())editSelection(c=>trimClipEnd(c,beat,audioMax(c)),e=>beat>e.clip.startBeat,'재생 커서가 선택 클립의 시작보다 뒤에 있어야 합니다.');break
      case 'muteTrack':if(selectedTrack)changeTrack(selectedTrack.id,{mute:!selectedTrack.mute});break
      case 'soloTrack':if(selectedTrack)changeTrack(selectedTrack.id,{solo:!selectedTrack.solo});break
      case 'trackUp':selectAdjacentTrack(-1);break
      case 'trackDown':selectAdjacentTrack(1);break
      case 'newTrack':addTrack('instrument','keys');break
      case 'deleteTrack':if(selectedTrack)requestDeleteTrack(selectedTrack.id);break
      case 'renameTrack':if(selectedTrack)setRenaming({kind:'track',id:selectedTrack.id});break
      case 'transposeUp':case 'transposeDown':case 'transposeOctaveUp':case 'transposeOctaveDown':{const n={transposeUp:1,transposeDown:-1,transposeOctaveUp:12,transposeOctaveDown:-12}[command];editSelection(c=>c.kind==='midi'?transposeClip(c,n):c,e=>e.clip.kind==='midi','음높이를 바꿀 MIDI 클립을 선택해주세요.');break}
      case 'deleteNotes':case 'quantize':break
    }
  }

  async function addAudioFiles(files:FileList,trackId?:string,beat=0){
    if(importing.current){notify('현재 파일을 불러온 뒤 다음 파일을 추가해주세요.');return}
    importing.current=true
    const session=projectSession.current
    setBusy('오디오를 불러오는 중…')
    try{
      const additions:{track:Track;existing:boolean;asset:AudioAsset;clip:AudioClip}[]=[]
      for(const file of Array.from(files)){
        const asset=await engine.decodeAsset(file,file.name)
        if(session!==projectSession.current)return
        const existing=additions.length===0&&trackId?project.tracks.find(t=>t.id===trackId&&t.kind==='audio'):undefined
        const track=existing??createTrack('audio')
        if(!existing)track.name=file.name.replace(/\.[^.]+$/,'')
        const clip:AudioClip={id:uid(),kind:'audio',name:file.name.replace(/\.[^.]+$/,''),startBeat:beat,lengthBeats:asset.buffer.duration*project.bpm/60,gain:1,assetId:asset.id,offsetSeconds:0,fadeIn:.005,fadeOut:.01}
        additions.push({track,existing:!!existing,asset,clip})
      }
      if(session!==projectSession.current)return
      setAssets(previous=>{const next=new Map(previous);for(const item of additions)next.set(item.asset.id,item.asset);return next})
      commit(p=>{let tracks=[...p.tracks];let end=p.lengthBeats
        for(const item of additions){const exists=tracks.some(t=>t.id===item.track.id);if(!exists)tracks.push({...item.track,clips:[]});tracks=tracks.map(t=>t.id===item.track.id?{...t,clips:[...t.clips,item.clip]}:t);end=Math.max(end,item.clip.startBeat+item.clip.lengthBeats)}
        return{...p,tracks,lengthBeats:Math.ceil(end/4)*4}
      })
      const last=additions.at(-1)
      if(last){select(last.track.id,last.clip.id);setBrowserTab('files');notify(`${additions.length}개 오디오 파일을 가져왔습니다. 원본은 로컬에 보관합니다.`)}
    }catch(error){notify(`파일을 가져오지 못했습니다: ${error instanceof Error?error.message:'지원되는 오디오 파일인지 확인해주세요'}`)}finally{importing.current=false;setBusy('');if(audioInput.current)audioInput.current.value=''}
  }
  function addStoredAsset(asset:AudioAsset){const clip:AudioClip={id:uid(),kind:'audio',assetId:asset.id,name:asset.name.replace(/\.[^.]+$/,''),startBeat:Math.floor(engine.getSnapshot().beat/4)*4,lengthBeats:asset.buffer.duration*project.bpm/60,offsetSeconds:0,gain:1,fadeIn:.005,fadeOut:.01};let target=selectedTrack?.kind==='audio'?selectedTrack:createTrack('audio');target={...target,clips:[...target.clips,clip]};const targetId=target.id;commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil((clip.startBeat+clip.lengthBeats)/4)*4),tracks:p.tracks.some(t=>t.id===targetId)?p.tracks.map(t=>t.id===targetId?target:t):[...p.tracks,target]}));select(targetId,clip.id)}
  async function saveBundle(){setBusy('프로젝트를 묶는 중…');try{downloadBlob(await exportProjectBundle(project,assets),`${safeFilename(project.name)}.garak`);notify('프로젝트와 원본 음원을 함께 내려받았습니다.')}catch(e){notify(`프로젝트 내보내기 실패: ${e instanceof Error?e.message:''}`)}finally{setBusy('')}}
  async function openBundle(file:File){if(recordRef.current||recordPreparing||busy){notify('녹음이나 파일 처리가 끝난 뒤 프로젝트를 열어주세요.');return}const session=++projectSession.current;setBusy('프로젝트를 여는 중…');try{const data=await importProjectBundle(file);const decoded=await Promise.all(data.assets.map(a=>engine.decodeAsset(a.blob,a.name,a.id)));if(session!==projectSession.current)return;engine.stop();const next=new Map(decoded.map(a=>[a.id,a]));engine.setAssets(next);setAssets(next);breakHistoryMerge();dispatch({type:'reset',project:data.project});select(data.project.tracks[0]?.id??'',data.project.tracks[0]?.clips[0]?.id);notify('프로젝트를 불러왔습니다.')}catch(e){notify(`프로젝트를 열지 못했습니다: ${e instanceof Error?e.message:''}`)}finally{setBusy('');if(projectInput.current)projectInput.current.value=''}}
  async function exportWav(){setModal(null);setBusy('오디오를 렌더링하는 중…');try{const blob=await engine.exportWav(project);downloadBlob(blob,`${safeFilename(project.name)}.wav`);notify('스테레오 WAV 파일을 내보냈습니다.')}catch(e){notify(`오디오 내보내기 실패: ${e instanceof Error?e.message:''}`)}finally{setBusy('')}}
  async function toggleRecord(){
    if(recordRef.current?.recorder.state==='recording'){recordRef.current.recorder.stop();engine.pause();return}
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){notify('이 브라우저에서는 마이크 녹음을 사용할 수 없습니다.');return}
    if(busy){notify('파일 처리가 끝난 뒤 녹음을 시작해주세요.');return}
    const session=projectSession.current
    setRecordPreparing(true)
    let acquiredStream:MediaStream|null=null
    try{await engine.resume();acquiredStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});const stream=acquiredStream;if(session!==projectSession.current){stream.getTracks().forEach(t=>t.stop());return}const chunks:Blob[]=[];const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);const beat=engine.getSnapshot().beat;const bpm=project.bpm;const trackId=selectedTrack?.kind==='audio'?selectedTrack.id:undefined;recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onerror=()=>notify('녹음 중 오류가 발생했습니다.');recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());recordRef.current=null;setRecording(false);if(session!==projectSession.current)return;setBusy('녹음 파일을 처리하는 중…');void(async()=>{try{const blob=new Blob(chunks,{type:recorder.mimeType});if(!blob.size)return;const name=`Recording ${new Date().toLocaleTimeString('ko-KR',{hour12:false})}`;const asset=await engine.decodeAsset(blob,name);if(session!==projectSession.current)return;setAssets(prev=>{const next=new Map(prev);next.set(asset.id,asset);return next});const clip:AudioClip={id:uid(),kind:'audio',name,startBeat:beat,lengthBeats:asset.buffer.duration*bpm/60,gain:1,assetId:asset.id,offsetSeconds:0,fadeIn:.005,fadeOut:.01};const newTrack=createTrack('audio');newTrack.name='Recording';const destination=trackId??newTrack.id;commit(p=>{const tracks=p.tracks.some(t=>t.id===destination)?p.tracks:[...p.tracks,{...newTrack,id:destination}];return{...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil((beat+clip.lengthBeats)/4)*4),tracks:tracks.map(t=>t.id===destination?{...t,clips:[...t.clips,clip]}:t)}});select(destination,clip.id);setBrowserTab('files');notify('녹음을 오디오 클립으로 추가했습니다.')}catch(e){notify(`녹음 처리 실패: ${e instanceof Error?e.message:''}`)}finally{setBusy('')}})()};recordRef.current={recorder,stream};recorder.start(100);setRecording(true);if(!engine.getSnapshot().playing)await engine.play()
    }catch(e){acquiredStream?.getTracks().forEach(t=>t.stop());recordRef.current=null;setRecording(false);notify(`녹음을 시작하지 못했습니다: ${e instanceof Error?e.message:'마이크 접근을 확인해주세요'}`)}finally{setRecordPreparing(false)}
  }
  function newProject(demo=false){if(recordRef.current||recordPreparing||busy){notify('녹음이나 파일 처리가 끝난 뒤 새 프로젝트를 시작해주세요.');return}projectSession.current+=1;stop();setAssets(new Map());engine.setAssets(new Map());const next=demo?createDemoProject():createEmptyProject();breakHistoryMerge();dispatch({type:'reset',project:next});select(next.tracks[0]?.id??'',next.tracks[0]?.clips[0]?.id);setModal(null);notify(demo?'Midnight Sketches 데모를 열었습니다.':'새로운 프로젝트를 시작합니다.')}

  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      if(isShortcutSuppressed(e,true)||!loaded)return
      if(modal){if(e.key==='Escape'&&isUnmodified(e)){e.preventDefault();if(!e.repeat)setModal(null)}return}
      const scope=shortcutScope(e.target),command=resolveProjectShortcut(e,scope,true);if(!command)return
      // Consume owned repeats so a held Space cannot scroll the document and
      // a held save key cannot fall through to the browser's Save Page dialog.
      e.preventDefault()
      if(e.repeat||busy)return
      // A gesture owns editing until commit/cancel. Its Escape capture handler
      // runs before this listener; undo/save/delete cannot race its draft.
      if(document.querySelector('[data-daw-gesture]'))return
      run(command,{scope})
    };window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)
  })

  useEffect(()=>{
    if(loaded&&!modal)return
    const dialog=document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');if(!dialog)return
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
    const focusable=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(el=>el.getClientRects().length>0)
    dialog.tabIndex=-1
    ;(focusable()[0]??dialog).focus({preventScroll:true})
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=='Tab'||event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return
      const items=focusable(),first=items[0],last=items.at(-1)
      if(!first){event.preventDefault();dialog.focus();return}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog||!dialog.contains(document.activeElement))){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}
    }
    window.addEventListener('keydown',trap,true)
    return()=>{window.removeEventListener('keydown',trap,true);if(previous?.isConnected)previous.focus({preventScroll:true})}
  },[loaded,modal,restoreError])

  // A pointer-clicked toolbar button must not keep focus, or Space would re-press it instead of playing.
  return <div className="studio-app" onClick={e=>{if(e.detail>0&&e.target instanceof Element){const button=e.target.closest<HTMLElement>('.icon-button,.play-button,.record-button,.transport-bar button,.editor-toolbar button,.header-actions button,.status-bar button');if(button&&!button.closest('[role="dialog"]'))button.blur()}}}>
    <header className="app-header">
      <button className="brand" onClick={()=>setModal('about')} title={`${BRAND.name} 정보`} aria-label={`${BRAND.name} 정보`}><Brand/></button>
      <div className="header-divider"/>
      <div className="project-identity"><NameInput aria-label="프로젝트 이름" value={project.name} onCommit={name=>commit(p=>({...p,name}),'project-name')}/><span className={`save-indicator ${saveStatus}`} title={saveStatus==='saved'?'이 브라우저에 자동 저장됨':saveStatus==='error'?'저장 오류':'저장 중'}><i/>{saveStatus==='saved'?'저장됨':saveStatus==='error'?'저장 실패':saveStatus==='loading'?'불러오는 중':'저장 중…'}</span></div>
      <div className="header-actions"><button className="header-text" onClick={()=>setModal('new')}>새 프로젝트</button><button className="icon-button" onClick={()=>projectInput.current?.click()} title="프로젝트 열기" aria-label="프로젝트 열기"><Icon name="folder"/></button><button className="icon-button" onClick={()=>void saveBundle()} title="프로젝트 파일 저장 · Ctrl/⌘ S" aria-label="프로젝트 파일 저장" disabled={!!busy}><Icon name="save"/></button><span className="header-divider"/><button className="export-button" onClick={()=>setModal('export')} disabled={!!busy}><Icon name="download" size={15}/><span>내보내기</span></button></div>
    </header>

    <Transport project={project} onChange={commit} onPlay={()=>void togglePlayback()} onStop={stop} onRecord={()=>void toggleRecord()} recording={recording} recordPreparing={recordPreparing} canUndo={history.past.length>0} canRedo={history.future.length>0} onUndo={()=>changeHistory('undo')} onRedo={()=>changeHistory('redo')} snap={snap} setSnap={setSnap} ppb={ppb} setPpb={setPpb}/>

    <div className={`studio-body ${!browserOpen?'browser-hidden':''} ${!inspectorOpen?'inspector-hidden':''}`}>
      {browserOpen&&<aside className={`browser-panel ${zoom.browser.compact?'compact':''}`} ref={browserRef}><div className="panel-heading"><span>브라우저</span><button className="icon-button small" onClick={()=>setBrowserOpen(false)} title="브라우저 접기" aria-label="브라우저 접기"><Icon name="panel" size={15}/></button></div><div className="browser-search"><Icon name="search" size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="소리 찾기…" aria-label="악기와 파일 검색"/><kbd>⌕</kbd></div><div className="browser-tabs"><button className={browserTab==='instruments'?'active':''} onClick={()=>setBrowserTab('instruments')}><Icon name="keys" size={14}/>악기</button><button className={browserTab==='files'?'active':''} onClick={()=>setBrowserTab('files')}><Icon name="folder" size={14}/>내 파일 <small>{assets.size||''}</small></button></div>
        <div className="browser-content">{browserTab==='instruments'?<>{INSTRUMENT_SECTIONS.map(section=>{const items=foundInstruments.filter(i=>section.categories.includes(i.category));return items.length?<Fragment key={section.title}><div className="browser-section-title"><span>{section.title}</span><span>{items.length}</span></div>{items.map(instrument=><div className="instrument-item" key={instrument.id}><button className="instrument-preview" title={`${instrument.name} 미리 듣기`} aria-label={`${instrument.name} 미리 듣기`} onClick={()=>void engine.previewNote(instrument.id,previewPitch(instrument)).catch(e=>notify(String(e)))} style={{color:instrument.color}}><Icon name={instrument.icon} size={22}/></button><button className="instrument-name" onClick={()=>addTrack('instrument',instrument.id)} title={instrument.description}><strong>{instrument.name}</strong><span>{instrument.nameKo} · {instrument.type}</span></button><button className="instrument-add" title={`${instrument.name} 트랙 추가`} aria-label={`${instrument.name} 트랙 추가`} onClick={()=>addTrack('instrument',instrument.id)}><Icon name="plus" size={15}/></button></div>)}</Fragment>:null})}<div className="browser-tip"><span className="tip-orbit"><Icon name="bolt" size={16}/></span><strong>작은 아이디어의 시작</strong><p>악기 아이콘을 눌러 들어보세요.<br/>＋ 버튼으로 트랙에 추가합니다.</p></div></>:<><div className="browser-section-title"><span>PROJECT AUDIO</span><button onClick={()=>{recordTarget.current={};audioInput.current?.click()}} title="오디오 가져오기" aria-label="오디오 가져오기"><Icon name="plus" size={15}/></button></div>{Array.from(assets.values()).filter(a=>a.name.toLowerCase().includes(search.toLowerCase())).map(asset=><button className="audio-file-item" key={asset.id} onClick={()=>addStoredAsset(asset)} title="클릭하여 타임라인에 추가"><span><Icon name="wave" size={14}/><strong>{asset.name}</strong></span><Waveform peaks={asset.peaks}/><small>{asset.buffer.duration.toFixed(1)} s · {asset.buffer.numberOfChannels===2?'STEREO':'MONO'} <Icon name="plus" size={12}/></small></button>)}{!assets.size&&<div className="files-empty"><Icon name="wave" size={28}/><p>나만의 소리를 가져오세요</p><span>오디오 파일은 기기에 보관됩니다.</span><button onClick={()=>{recordTarget.current={};audioInput.current?.click()}}>파일 선택</button></div>}</> }</div>
        <button className="browser-import" onClick={()=>{recordTarget.current={};audioInput.current?.click()}}><Icon name="upload" size={16}/><span>오디오 가져오기</span><Icon name="plus" size={14}/></button><div className="browser-foot"><Icon name="moon" size={14}/><span>YOUR SPACE FOR SOUND.</span></div>
      </aside>}

      <main className="studio-main"><Timeline project={project} assets={assets} engine={engine} selectedTrackId={selectedTrackId} selectedClipIds={selectedClipIds} pixelsPerBeat={ppb} rowHeight={zoom.timeline.rowHeight} snap={snap} renaming={renaming} onRenaming={setRenaming} onSelect={select} onSelectClips={selectFromMarquee} onTrackSelect={selectTrack} onTrackOpen={id=>{select(id);setBottomTab('devices')}} onClipOpen={openClip} onTrackChange={changeTrack} onTrackAction={trackAction} onTrackMove={moveTrack} onClipRename={(id,name)=>commit(p=>mapClips(p,new Set([id]),c=>({...c,name})))} onClipsEdit={applyClipEdit} onLoopChange={changeLoop} onZoom={setPpb} onZoomY={setRowHeight} onCommand={(command,ctx)=>run(command,ctx)} onAddClip={addMidiClip} onAudioDrop={(files,id,beat)=>void addAudioFiles(files,id,beat)} onAddTrack={()=>addTrack()}/>
        <section className="bottom-panel"><div className="editor-toolbar"><div className="editor-tabs"><button className={bottomTab==='editor'?'active':''} onClick={()=>setBottomTab('editor')}><Icon name={selectedClip?.kind==='audio'?'wave':'keys'} size={15}/>{selectedClip?.kind==='audio'?'오디오 편집':'피아노롤'}</button><button className={bottomTab==='mixer'?'active':''} onClick={()=>setBottomTab('mixer')}><Icon name="mixer" size={15}/>믹서</button><button className={bottomTab==='devices'?'active':''} onClick={()=>setBottomTab('devices')}><Icon name="plug" size={15}/>디바이스</button></div><div className="editor-selection">{selectedClip&&<><span className="color-dot" style={{background:selectedTrack?.color}}/><span>{selectedClip.name}</span><small>{+(selectedClip.lengthBeats/4).toFixed(2)} bars{selection.length>1?` · 클립 ${selection.length}개 선택`:''}</small></>}</div><div className="editor-actions">{bottomTab==='mixer'?<ZoomControls area="믹서" onZoom={command=>zoomArea(command,'mixer')} focusTarget={()=>document.querySelector<HTMLElement>('[data-keyboard-scope="mixer"]')}/>:bottomTab==='devices'&&selectedTrack?<ZoomControls area="디바이스" axes="one" labels={{zoomOut:'축소',zoomIn:'확대',zoomToFit:'기본 크기'}} onZoom={command=>zoomArea(command,'devices')} focusTarget={()=>document.querySelector<HTMLElement>('[data-keyboard-scope="devices"]')}/>:null}<button className="icon-button small" onClick={splitSelection} disabled={!selection.length&&!selectedTrack?.clips.length} title={`재생 커서에서 클립 분할 · ${shortcutText('split')}`} aria-label="클립 분할"><Icon name="scissors" size={15}/></button><button className="icon-button small" onClick={duplicateSelection} disabled={!selection.length} title={`선택 클립 복제 · ${shortcutText('duplicate')}`} aria-label="클립 복제"><Icon name="copy" size={15}/></button><button className="icon-button small" onClick={()=>{if(selection.length)deleteSelectedClips();else if(selectedTrack)requestDeleteTrack(selectedTrack.id)}} disabled={!selectedTrack&&!selection.length} title={selection.length?`선택 클립 ${selection.length}개 삭제`:'선택 트랙 삭제…'} aria-label={selection.length?'클립 삭제':'트랙 삭제'}><Icon name="trash" size={15}/></button></div></div>
          {bottomTab==='mixer'?<Mixer project={project} engine={engine} selectedTrackId={selectedTrackId} onSelect={id=>select(id)} onTrackChange={changeTrack} onDeleteTrack={requestDeleteTrack} onDuplicateTrack={id=>trackAction(id,'duplicate')} onMasterChange={value=>commit(p=>({...p,masterVolume:value}),'master-volume')} zoom={zoom.mixer} onZoomChange={mixer=>setZoom(z=>({...z,mixer:{channelWidth:clampZoom(mixer.channelWidth,ZOOM_LIMITS.mixerWidth),faderHeight:clampZoom(mixer.faderHeight,ZOOM_LIMITS.mixerFader)}}))} zoomRef={mixerZoom}/>:bottomTab==='devices'?selectedTrack?<DeviceChain track={selectedTrack} engine={engine} scale={zoom.devices.scale} onScaleChange={scale=>patchZoom('devices',()=>({scale:clampZoom(scale,ZOOM_LIMITS.deviceScale)}))} zoomRef={deviceZoom} onInstrumentChange={instrument=>changeInstrument(selectedTrack.id,instrument)} onInstrumentParam={(key,value)=>editTrack(selectedTrack.id,t=>({...t,instrumentParams:{...t.instrumentParams,[key]:value}}),`${selectedTrack.id}:inst:${key}`)} onDeviceParam={(deviceId,key,value)=>editTrack(selectedTrack.id,t=>({...t,devices:t.devices.map(d=>d.id===deviceId?{...d,params:{...d.params,[key]:value}}:d)}),`${selectedTrack.id}:dev:${deviceId}:${key}`)} onAddDevice={type=>addDevice(selectedTrack.id,type)} onRemoveDevice={deviceId=>editTrack(selectedTrack.id,t=>({...t,devices:t.devices.filter(d=>d.id!==deviceId)}))} onMoveDevice={(deviceId,offset)=>editTrack(selectedTrack.id,t=>moveDevice(t,deviceId,offset))} onToggleDevice={deviceId=>toggleDevice(selectedTrack.id,deviceId)} onTrackChange={patch=>changeTrack(selectedTrack.id,patch)} onPreview={()=>previewTrack(selectedTrack)}/>:<div className="editor-empty"><Icon name="plug" size={32}/><strong>소리의 흐름을 한눈에</strong><p>트랙 헤더를 클릭하면 악기와 연결된 이펙트가 여기에 열립니다.</p></div>:selectedClip?.kind==='midi'&&selectedTrack?<PianoRollBridge clip={selectedClip} color={selectedTrack.color} instrument={selectedTrack.instrument} zoom={zoom.piano} onZoomChange={piano=>setZoom(z=>({...z,piano}))} zoomRef={pianoZoom} onChange={clip=>changeClip(clip)} onPreview={pitch=>void engine.previewNote(selectedTrack.instrument,pitch,undefined,selectedTrack.id).catch(e=>notify(String(e)))}/>:selectedClip?.kind==='audio'?<div className="audio-editor"><div className="audio-wave-large">{assets.get(selectedClip.assetId)&&<Waveform peaks={assets.get(selectedClip.assetId)!.peaks} color={selectedTrack?.color}/>}</div><div className="audio-editor-settings"><label>클립 게인<input type="range" min="0" max="2" step=".01" value={selectedClip.gain} onChange={e=>changeClip({...selectedClip,gain:+e.target.value},`${selectedClip.id}:gain`)}/><span>{db(selectedClip.gain)} dB</span></label><label>페이드 인<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeIn} onChange={e=>changeClip({...selectedClip,fadeIn:+e.target.value},`${selectedClip.id}:fadeIn`)}/><span>{selectedClip.fadeIn.toFixed(2)} s</span></label><label>페이드 아웃<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeOut} onChange={e=>changeClip({...selectedClip,fadeOut:+e.target.value},`${selectedClip.id}:fadeOut`)}/><span>{selectedClip.fadeOut.toFixed(2)} s</span></label></div></div>:<div className="editor-empty"><Icon name="keys" size={32}/><strong>아이디어를 음표로</strong><p>클립을 선택하거나 타임라인을 더블 클릭해 패턴을 만드세요.</p>{selectedTrack?.kind==='instrument'&&<button onClick={()=>addMidiClip(selectedTrack.id,0)}><Icon name="plus" size={14}/> MIDI 클립 만들기</button>}</div>}
        </section>
      </main>

      {inspectorOpen&&<aside className="inspector-panel"><div className="panel-heading"><span>인스펙터</span><button className="icon-button small" onClick={()=>setInspectorOpen(false)} title="인스펙터 접기" aria-label="인스펙터 접기"><Icon name="settings" size={15}/></button></div>{selectedTrack?<>
        <div className="selected-track-card"><span className="selected-instrument-icon" style={{background:selectedTrack.color+'18',color:selectedTrack.color}}><Icon name={selectedTrack.kind==='audio'?'wave':selectedInstrument?.icon??'keys'} size={26}/></span><div><span className="eyebrow">{selectedTrack.kind==='audio'?'AUDIO TRACK':'INSTRUMENT TRACK'}</span><NameInput aria-label="트랙 이름" value={selectedTrack.name} onCommit={name=>changeTrack(selectedTrack.id,{name})}/></div></div>
        <div className="inspector-section"><div className="section-label">TRACK <div className="track-color-options">{TRACK_COLORS.map(([color,name])=><button key={color} style={{background:color}} className={selectedTrack.color===color?'chosen':''} onClick={()=>changeTrack(selectedTrack.id,{color})} aria-label={`트랙 색상 ${name}`} title={name}/>)}</div></div><div className="volume-label"><span>볼륨</span><b>{db(selectedTrack.volume)} <small>dB</small></b></div><input className="full-slider" aria-label="선택 트랙 볼륨" type="range" min="0" max="1.5" step=".01" value={selectedTrack.volume} onChange={e=>changeTrack(selectedTrack.id,{volume:+e.target.value})}/><div className="volume-label"><span>팬</span><b>{Math.abs(selectedTrack.pan)<.01?'C':`${Math.round(Math.abs(selectedTrack.pan)*100)}${selectedTrack.pan<0?' L':' R'}`}</b></div><input className="full-slider pan-slider" aria-label="선택 트랙 팬" type="range" min="-1" max="1" step=".01" value={selectedTrack.pan} onChange={e=>changeTrack(selectedTrack.id,{pan:+e.target.value})}/><div className="track-toggle-row"><button className={selectedTrack.mute?'active':''} onClick={()=>changeTrack(selectedTrack.id,{mute:!selectedTrack.mute})}>M <span>뮤트</span></button><button className={selectedTrack.solo?'active solo':''} onClick={()=>changeTrack(selectedTrack.id,{solo:!selectedTrack.solo})}>S <span>솔로</span></button></div></div>
        {selectedTrack.kind==='instrument'&&<div className="inspector-section"><div className="section-label">INSTRUMENT <span className="online-dot"/></div><div className="device-card" style={{'--device-color':selectedTrack.color} as React.CSSProperties}><div className="device-top"><Icon name={selectedInstrument?.icon??'keys'} size={18}/><span>{selectedInstrument?.name}</span></div><div className="device-art"><svg viewBox="0 0 190 46" aria-hidden="true"><path d={selectedInstrument?.isKit?'M0 24h18l2-18 3 34 3-30 4 14h25l2-15 4 31 3-26 4 10h24l2-12 4 27 3-25 4 10h25l2-19 4 35 3-26 4 10h25':'M0 23C12-8 18-8 30 23s18 31 30 0 18-31 30 0 18 31 30 0 18-31 30 0 18 31 30 0 18-31 30 0'} fill="none" stroke="currentColor" strokeWidth="1.5"/></svg></div><select aria-label="악기 변경" value={selectedTrack.instrument} onChange={e=>changeInstrument(selectedTrack.id,e.target.value)}><InstrumentOptions/></select></div></div>}
        <div className="inspector-section devices-section"><div className="section-label">DEVICES <span>{selectedTrack.devices.length}</span></div>{selectedTrack.devices.length?<ol className="inspector-devices">{selectedTrack.devices.map(d=><li key={d.id} className={d.enabled?'':'bypassed'}><button className={d.enabled?'on':''} aria-pressed={d.enabled} title="켜기/끄기 (바이패스)" aria-label={`${EFFECT_DEFS[d.type].name} 켜기/끄기`} onClick={()=>toggleDevice(selectedTrack.id,d.id)}><Icon name="power" size={10}/></button><span>{EFFECT_DEFS[d.type].name}</span></li>)}</ol>:<p className="inspector-devices-empty">연결된 이펙트가 없습니다</p>}<button className="inspector-open-chain" onClick={()=>setBottomTab('devices')}><Icon name="plug" size={13}/>디바이스 체인 열기</button></div>
        {selectedClip&&<div className="inspector-section clip-properties"><div className="section-label">CLIP {selection.length>1&&<span>{selection.length}개 선택</span>}</div><NameInput aria-label="클립 이름" value={selectedClip.name} onCommit={name=>changeClip({...selectedClip,name},`${selectedClip.id}:name`)}/><div><span>상태</span><button className={`clip-mute-toggle ${selectedClip.mute?'active':''}`} aria-pressed={!!selectedClip.mute} onClick={()=>changeClip({...selectedClip,mute:!selectedClip.mute})}>{selectedClip.mute?'뮤트됨':'재생'}</button></div><div><span>시작</span><b>{(selectedClip.startBeat/4+1).toFixed(2)} bar</b></div><div><span>길이</span><b>{(selectedClip.lengthBeats/4).toFixed(2)} bars</b></div></div>}
      </>:<div className="inspector-empty"><Icon name="settings" size={26}/><p>트랙을 선택해주세요</p></div>}<div className="master-strip"><div><Icon name="volume" size={14}/><span>MASTER OUT</span><b>{db(project.masterVolume)} dB</b></div><MiniMeter engine={engine}/><input aria-label="마스터 출력 볼륨" type="range" min="0" max="1.5" step=".01" value={project.masterVolume} onChange={e=>commit(p=>({...p,masterVolume:+e.target.value}),'master-volume')}/></div></aside>}
    </div>

    <footer className="status-bar"><div><button className={browserOpen?'active':''} onClick={()=>setBrowserOpen(!browserOpen)} aria-label="브라우저 패널 전환" title="브라우저 패널 전환"><Icon name="panel" size={14}/></button><span className={`status-dot ${saveStatus==='error'?'error':''}`}/><span>{saveStatus==='error'?'저장 공간을 확인해주세요':'로컬 작업 공간'}</span><span className="status-divider"/><span className="footer-caption">소리는 여기에서 시작됩니다.</span></div><div><AudioStatus/><span className="status-divider"/><button onClick={()=>setModal('help')} title="단축키" aria-label="단축키 도움말"><Icon name="keyboard" size={15}/></button><button className={inspectorOpen?'active':''} onClick={()=>setInspectorOpen(!inspectorOpen)} title="인스펙터 패널 전환" aria-label="인스펙터 패널 전환"><Icon name="settings" size={15}/></button><span className="version-tag">{BRAND.version} DEV</span></div></footer>

    <input ref={audioInput} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aiff" multiple hidden onChange={e=>{if(e.target.files?.length)void addAudioFiles(e.target.files,recordTarget.current.trackId,recordTarget.current.beat??0)}}/>
    <input ref={projectInput} type="file" accept=".garak,.noct,.json,application/json" hidden onChange={e=>{if(e.target.files?.[0])void openBundle(e.target.files[0])}}/>
    {!loaded&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">{restoreError?<><h2 id="restore-title">저장된 작업을 확인해주세요</h2><p>{restoreError}</p><p>기존 저장본을 보존하기 위해 자동 저장을 멈췄습니다. 새 프로젝트를 시작하면 기존 자동 저장본이 교체됩니다.</p><div className="modal-buttons"><button onClick={()=>window.location.reload()}>다시 시도</button><button className="primary" onClick={()=>{newProject();setRestoreError('');setLoaded(true)}}>새 프로젝트 시작</button></div></>:<><span className="spinner"/><h2 id="restore-title" style={{marginTop:20}}>작업 공간을 준비합니다</h2><p>저장된 프로젝트와 원본 음원을 불러오고 있습니다.</p></>}</section></div>}
    {notice&&<div className="toast" role="status"><Icon name="info" size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="알림 닫기"><Icon name="close" size={15}/></button></div>}
    {busy&&<div className="busy-indicator" role="status"><span className="spinner"/>{busy}</div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className={`modal ${modal==='help'?'modal-help':''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close icon-button" onClick={()=>setModal(null)} aria-label="창 닫기"><Icon name="close"/></button>
      {modal==='new'?<><span className="modal-symbol"><Icon name="plus" size={27}/></span><h2 id="modal-title">다음 아이디어를 시작할까요?</h2><p>현재 프로젝트를 계속 보관하려면 먼저 프로젝트 파일을 내려받으세요. 새 프로젝트는 자동 저장된 작업을 대체합니다.</p><button className="modal-save" onClick={()=>void saveBundle()}><Icon name="save" size={16}/> 현재 프로젝트 내려받기</button><div className="modal-buttons"><button onClick={()=>newProject(true)}>데모 곡 열기</button><button className="primary" onClick={()=>newProject()}>빈 프로젝트 만들기</button></div></>:modal==='export'?<><span className="modal-symbol"><Icon name="download" size={26}/></span><h2 id="modal-title">음악을 밖으로</h2><p>모든 트랙과 현재 믹서 설정을 하나의 스테레오 파일로 만듭니다.</p><div className="export-summary"><span>파일 이름<b>{project.name||'Untitled'}.wav</b></span><span>범위<b>{project.lengthBeats/4} 마디 · {(project.lengthBeats*60/project.bpm).toFixed(1)}초</b></span><span>프로젝트<b>{project.tracks.length} tracks · {project.bpm} BPM</b></span><span>형식<b>Stereo PCM WAV</b></span></div><button className="primary modal-wide" onClick={()=>void exportWav()}><Icon name="download" size={16}/> WAV 내보내기</button><button className="text-link" onClick={()=>{setModal(null);void saveBundle()}}>편집 가능한 프로젝트(.garak)로 보관하기</button></>:modal==='deleteTrack'?(()=>{const track=project.tracks.find(t=>t.id===pendingDeleteTrack);return <><span className="modal-symbol danger"><Icon name="trash" size={25}/></span><h2 id="modal-title">트랙을 삭제할까요?</h2><p>{track?`트랙 '${track.name}'와 클립 ${track.clips.length}개를 삭제할까요? 실행 취소(${shortcutText('undo')})로 되돌릴 수 있습니다.`:'삭제할 트랙이 없습니다.'}</p><div className="modal-buttons"><button onClick={()=>{setModal(null);setPendingDeleteTrack(null)}}>취소</button><button className="primary danger" onClick={confirmDeleteTrack} disabled={!track}>삭제</button></div></>})():modal==='help'?<><span className="modal-symbol"><Icon name="keyboard" size={27}/></span><h2 id="modal-title">손끝에서 이어지는 작업</h2><div className="shortcut-groups">{SCOPE_GROUPS.map(([key,title])=>{const rows=SHORTCUT_TABLE.filter(r=>r.scopes.join(',')===key&&!ZOOM_COMMANDS.includes(r.command));return rows.length?<section key={key} className="shortcut-list"><h3>{title}</h3>{rows.map(r=><div key={r.command}><span>{r.label}</span><kbd>{(shortcutPlatform()==='mac'?r.mac:r.win)||'—'}</kbd></div>)}</section>:null})}<section className="shortcut-list"><h3>확대/축소 · 키 포커스가 있는 영역에 적용</h3>{SHORTCUT_TABLE.filter(r=>ZOOM_COMMANDS.includes(r.command)).map(r=><div key={r.command}><span>{r.label}</span><kbd>{shortcutPlatform()==='mac'?r.mac:r.win}</kbd></div>)}<div><span>가로 확대/축소 (포인터 기준)</span><kbd>{shortcutPlatform()==='mac'?'⌘':'Ctrl+'}휠 · 핀치</kbd></div><div><span>세로 확대/축소 (포인터 기준)</span><kbd>{shortcutPlatform()==='mac'?'⇧⌘':'Ctrl+Shift+'}휠 / {shortcutPlatform()==='mac'?'⌥':'Alt+'}휠</kbd></div></section></div><p className="modal-note">클릭은 선택, Shift/{shortcutPlatform()==='mac'?'⌘':'Ctrl'}+클릭은 선택 추가, 빈 곳 드래그는 범위 선택입니다. 드래그 중 {shortcutPlatform()==='mac'?'⌥':'Alt'} = 복사, Ctrl = 세밀하게, Ctrl+Shift = 스냅 무시, Shift = 축 고정. 클립을 더블 클릭하면 편집기가 열립니다.</p></>:<><Brand size="large"/><h2 id="modal-title">음악을 위한 나만의 공간.</h2><p>React와 Web Audio로 만드는 오픈소스 DAW입니다. 프로젝트와 음원은 브라우저에 로컬로 저장합니다.</p><div className="about-roadmap"><span><b>1.0</b> 웹 편집기 + 오디오 엔진 <small>개발 중</small></span><span><b>2.0</b> 로컬 호스트 + VST 연결 <small>예정</small></span></div><div className="about-meta">React 19.3.1 · TypeScript · 코드 MIT License</div><div className="sample-credits"><strong>샘플 악기 출처</strong>{SAMPLE_CREDITS.map(c=><span key={c.title}>{c.url?<a href={c.url} target="_blank" rel="noreferrer">{c.title}</a>:c.title} — {c.author}, {c.license} <small>{c.instruments}</small></span>)}</div>{SOURCE_REPOSITORY_URL&&<a className="modal-save" href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer"><Icon name="external" size={16}/> GitHub 소스 코드</a>}<div className="font-credit">이름 글꼴: <a href={BRAND.fontSource} target="_blank" rel="noreferrer">{BRAND.fontName}</a><br/>국립한글박물관 · ㈜윤디자인그룹<br/><a href={BRAND.fontLicense} target="_blank" rel="noreferrer">공공누리 제3유형 · 글꼴 이용 조건</a></div></>}
    </section></div>}
  </div>
}

/** Edits commit while typing; an emptied field is never committed and reverts on blur. */
function NameInput({value,onCommit,...rest}:{value:string;onCommit:(name:string)=>void}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'>){
  const [draft,setDraft]=useState<string|null>(null)
  return <input {...rest} value={draft??value} maxLength={512} onChange={e=>{const name=e.target.value;setDraft(name);if(name.trim())onCommit(name)}} onBlur={e=>{setDraft(null);rest.onBlur?.(e)}} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing)e.currentTarget.blur();rest.onKeyDown?.(e)}}/>
}
/** Only this subtree re-renders with the transport clock, not the whole App. */
function PianoRollBridge(props:Omit<ComponentProps<typeof PianoRoll>,'playheadBeat'>){
  const snapshot=useSyncExternalStore(subscribeTransport,readTransport,readTransport)
  return <PianoRoll {...props} playheadBeat={snapshot.beat}/>
}
function AudioStatus(){const s=useSyncExternalStore(subscribeTransport,readTransport,readTransport);return <span className="audio-status"><Icon name="headphones" size={13}/>{s.ready?`${(s.sampleRate/1000).toFixed(1)} kHz · Stereo`:'오디오 준비됨'}</span>}
function Transport({project,onChange,onPlay,onStop,onRecord,recording,recordPreparing,canUndo,canRedo,onUndo,onRedo,snap,setSnap,ppb,setPpb}:{project:Project;onChange:(fn:(p:Project)=>Project,key?:string)=>void;onPlay:()=>void;onStop:()=>void;onRecord:()=>void;recording:boolean;recordPreparing:boolean;canUndo:boolean;canRedo:boolean;onUndo:()=>void;onRedo:()=>void;snap:number;setSnap:(n:number)=>void;ppb:number;setPpb:(n:number)=>void}){
  const snapshot=useSyncExternalStore(subscribeTransport,readTransport,readTransport)
  const bar=Math.floor(snapshot.beat/4)+1,beat=Math.floor(snapshot.beat%4)+1,tick=Math.floor((snapshot.beat%1)*100)
  const seconds=snapshot.beat*60/project.bpm
  return <div className="transport-bar"><div className="history-buttons"><button className="icon-button" onClick={onUndo} disabled={!canUndo} title="실행 취소" aria-label="실행 취소"><Icon name="undo" size={16}/></button><button className="icon-button" onClick={onRedo} disabled={!canRedo} title="다시 실행" aria-label="다시 실행"><Icon name="redo" size={16}/></button></div><span className="transport-divider"/><div className="transport-buttons"><button className="icon-button" onClick={()=>engine.seek(0)} title="처음으로 · Home" aria-label="처음으로"><Icon name="back" size={17}/></button><button className="icon-button stop-button" onClick={onStop} title="정지" aria-label="정지"><Icon name="stop" size={15}/></button><button className={`play-button ${snapshot.playing?'playing':''}`} onClick={onPlay} title="재생 / 일시 정지 · Space" aria-label={snapshot.playing?'일시 정지':'재생'}><Icon name={snapshot.playing?'pause':'play'} size={18}/></button><button className={`record-button ${recording?'recording':''}`} onClick={onRecord} disabled={recordPreparing} title={recording?'녹음 종료':'마이크 녹음 시작'} aria-label={recording?'녹음 종료':'마이크 녹음'}><i/></button><button className={`icon-button loop-toggle ${project.loop.enabled?'active':''}`} onClick={()=>onChange(p=>({...p,loop:{...p.loop,enabled:!p.loop.enabled}}))} aria-label="루프 재생" aria-pressed={project.loop.enabled} title="루프 재생"><Icon name="loop" size={18}/></button></div><span className="transport-divider"/><div className="time-display"><strong>{String(bar).padStart(3,'0')}<i>.</i>{beat}<i>.</i>{String(tick).padStart(2,'0')}</strong><span>{String(Math.floor(seconds/60)).padStart(2,'0')}:{(seconds%60).toFixed(2).padStart(5,'0')}</span></div><div className="tempo-box"><input type="number" min="30" max="300" value={project.bpm} disabled={recording} onChange={e=>{const bpm=+e.target.value;if(bpm>=30&&bpm<=300)onChange(p=>({...p,bpm}),'tempo')}} aria-label="템포 BPM"/><span>BPM</span></div><div className="time-signature"><strong>4 / 4</strong><span>SIGNATURE</span></div><div className="loop-length"><label>LOOP<select aria-label="루프 길이" value={project.loop.endBeat-project.loop.startBeat} onChange={e=>{const n=+e.target.value;onChange(p=>({...p,lengthBeats:Math.max(p.lengthBeats,p.loop.startBeat+n),loop:{...p.loop,endBeat:p.loop.startBeat+n}}));e.currentTarget.blur()}}>{[...new Set([4,8,16,32,64,128,project.loop.endBeat-project.loop.startBeat])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{+(n/4).toFixed(2)} bars</option>)}</select></label></div><div className="transport-spacer"/><div className="snap-control"><Icon name="magnet" size={15}/><select value={snap} onChange={e=>{setSnap(+e.target.value);e.currentTarget.blur()}} aria-label="스냅 간격"><option value="0">스냅 끔</option><option value="0.25">1/16</option><option value="0.5">1/8</option><option value="1">1/4</option><option value="4">1 bar</option></select></div></div>
}
