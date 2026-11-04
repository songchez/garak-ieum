import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentProps, InputHTMLAttributes, SetStateAction } from 'react'
import { WebAudioEngine } from './audio/WebAudioEngine'
import { InputCapture } from './audio/InputCapture'
import { AudioRecording } from './audio/AudioRecording'
import { quarterNotesPerBeat, setProjectTimeSignature } from './core/meter'
import { TempoInput } from './components/TempoInput'
import { TimeSignatureControl } from './components/TimeSignatureControl'
import { bindRecordingToTransport, pausePlaybackWithRecording, stopPlaybackWithRecording, togglePlaybackWithRecording } from './audio/recordingTransport'
import { inputConstraints, loadAudioSettings, normalizeAudioSettings, saveAudioSettings, type AudioSettings, type SampleRate } from './core/audioSettings'
import { appendAudioRecording, recordingStartBeat, type RecordingDraft } from './core/recording'
import type { AudioAsset, AudioClip, Clip, EffectType, InstrumentId, MidiClip, Project, Track } from './core/types'
import { addMarker, applyDragMode, createDevice, createEmptyProject, createGuitarTrack, createMarker, createTrack, cycleClipIds, deleteMarker, duplicateClip, duplicateTrack, duplicateTrackSettings, fitProjectLength, insertTracks, joinClips, moveDevice, moveMarker, renameMarker, splitClip, trimClipEnd, trimClipStart, trimClipStarts, uid, visibleTracks, withInstrument, withWavetablePatch, type ClipStartTrim } from './core/project'
import { SAMPLE_CREDITS, instrumentDef, previewPitch } from './core/instruments'
import { exportProjectBundle, loadProject, saveProject } from './core/storage'
import { clearRecallSolo, effectiveArm, implicitlyMuted, monitorTargets, pressTrackButton, recordTarget, sweepTrackButton, type TrackButtonKind, type TrackButtonMods } from './core/trackActions'
import { TRACK_ICON_OPTIONS, TRACK_ZOOM_LIMITS, VIEW_STORAGE_KEY, loadTrackHeader, loadTrackZoom, loadView, pruneTrackZoom, resolveSnap, saveTrackHeader, saveTrackZoom, saveView, type TrackHeaderState, type TrackZoom, type ViewState } from './core/trackUi'
import { Icon } from './components/Icon'
import { Brand } from './components/Brand'
import { GiwaEave } from './components/GiwaEave'
import { BRAND, SOURCE_REPOSITORY_URL } from './brand'
import { Timeline, type TimelineUi } from './components/Timeline'
import PianoRoll from './components/PianoRoll'
import Mixer from './components/Mixer'
import { Waveform } from './components/Waveform'
import { EditorPanel, EditorPanelActions, EditorPanelBody } from './components/EditorPanel'
import { setClipLoopEnd } from './core/project'
import { DeviceChain } from './components/DeviceChain'
import { applyPitchDocument, assertPitchSourceTiming, encodePitchWav, hasPitchAudioEdits, restorePitchSource, validatePitchDocument } from './devices/pitch-editor/state'
import { firstPitchDraftId, pitchDrafts, reconcilePitchDrafts } from './devices/pitch-editor/draftCache'
import type { PitchRenderedEdit } from './devices/pitch-editor/model'
import { Inspector } from './components/Inspector'
import { Library } from './components/Library'
import { Browser } from './components/Browser'
import { NewTracksDialog, type NewTracksOptions } from './components/NewTracksDialog'
import { ColorPalette } from './components/ColorPalette'
import { HeaderConfigPopover } from './components/HeaderConfigPopover'
import ContextMenu from './components/ContextMenu'
import { SHORTCUT_TABLE, ZOOM_COMMANDS, isShortcutSuppressed, isUnmodified, resolveProjectShortcut, resolveRoutedShortcut, shortcutEditorScope, shortcutLabel, shortcutPlatform, shortcutScope, type ProjectShortcut, type ShortcutEditScope, type ShortcutScope } from './core/input'
import { bindTransportShortcuts, isTransportTextTarget } from './core/transportShortcuts'
import { DEVICE_KEY_FACTOR, ZOOM_KEY_FACTOR, ZOOM_KEY_FACTOR_V, ZOOM_LIMITS, clampZoom, fitScale, loadZoom, saveZoom, zoomBy, type ZoomCommand, type ZoomHandle, type ZoomState } from './core/zoom'
import { ZoomControls } from './components/ZoomControls'
import AudioSettingsDialog from './components/AudioSettingsDialog'
import McpConnectionDialog from './components/McpConnectionDialog'
import { ProjectSession } from './core/ProjectSession'
import { HistoryGestureContext } from './core/historyGesture'
import { createDawRequestHandler } from './automation/host'
import { DawBridgeClient, type DawBridgeHandler } from './automation/bridgeClient'
import { isDesktopApp, saveExport } from './platform/desktop'

// An application-session service, independent of React's render/effect lifecycle.
const initialAudioSettings = loadAudioSettings()
const PitchEditor = lazy(() => import('./devices/pitch-editor/PitchEditor').then(module => ({ default: module.PitchEditor })))
const engine = new WebAudioEngine(undefined, initialAudioSettings)
const subscribeTransport = (cb:()=>void)=>engine.subscribe(cb)
const readTransport = ()=>engine.getSnapshot()
if(import.meta.hot)import.meta.hot.dispose(()=>engine.dispose())

const safeFilename=(name:string)=>name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim()||'Untitled'
const db=(n:number)=>n<=0?'−∞':(20*Math.log10(n)).toFixed(1)
type ClipEntry={clip:Clip;track:Track;row:number}
type Clipboard={items:{clip:Clip;row:number;kind:Track['kind']}[];base:number;topRow:number}
type TrackMods={range:boolean;toggle:boolean;trackOnly:boolean}
type ClipMove={trackId:string;clipId:string;start:number;length?:number;toTrackId?:string}
type NewTrackOptions={kind?:Track['kind'];sameAsFocused?:boolean;empty?:boolean;dialog?:boolean;afterId?:string|null}
type CommandContext={trackIds?:string[];clipIds?:string[];scope?:ShortcutScope}
const LIVE_KEYS=new Set<keyof Track>(['armed','monitor'])
const TRACK_EDIT_LABELS:Partial<Record<keyof Track,string>>={volume:'볼륨 조절',pan:'팬 조절',name:'트랙 이름 변경',mute:'트랙 음소거',solo:'트랙 솔로',enabled:'트랙 켬/끔',hidden:'트랙 가리기',color:'트랙 색상 변경',instrument:'악기 변경',icon:'트랙 아이콘 변경'}
/** Replaces the listed clips (null removes, an array splits) and keeps untouched tracks' identity. */
function mapClips(p:Project,ids:ReadonlySet<string>,fn:(clip:Clip,track:Track)=>Clip|Clip[]|null):Project{
  let changed=false
  const tracks=p.tracks.map(t=>{if(!t.clips.some(c=>ids.has(c.id)))return t;changed=true;return{...t,clips:t.clips.flatMap(c=>{if(!ids.has(c.id))return[c];const r=fn(c,t);return r===null?[]:Array.isArray(r)?r:[r]})}})
  return changed?{...p,tracks}:p
}
const addClips=(p:Project,additions:{trackId:string;clip:Clip}[]):Project=>({...p,tracks:p.tracks.map(t=>{const add=additions.filter(a=>a.trackId===t.id).map(a=>a.clip);return add.length?{...t,clips:[...t.clips,...add]}:t})})
const shortcutText=(command:ProjectShortcut)=>shortcutLabel(command)
const SCOPE_GROUPS:[string,string][]=[['timeline,piano,workspace','어디서나'],['timeline,workspace','타임라인·작업 공간'],['timeline,piano','타임라인·피아노롤'],['timeline','타임라인'],['piano','피아노롤'],['workspace','작업 공간']]
const anchorAt=(el:Element|null|undefined,fallback={x:Math.max(8,window.innerWidth/2-160),y:160})=>{const r=el?.getBoundingClientRect();return r?{x:r.left,y:r.bottom+4}:fallback}

export interface StudioAppProps {
  projectId:string
  navigating:boolean
  navigationError?:string
  onHome():void
  onNew():void
  onOpenProject():void
  registerNavigationGuard(guard:()=>Promise<boolean>):()=>void
  registerProjectSave(save:()=>Promise<void>):()=>void
}

export default function App({projectId,navigating,navigationError,onHome,onNew,onOpenProject,registerNavigationGuard,registerProjectSave}:StudioAppProps){
  const desktop=isDesktopApp()
  const [commandSession]=useState(()=>new ProjectSession({...createEmptyProject(),id:projectId}))
  const commandState=useSyncExternalStore(commandSession.subscribe,commandSession.getSnapshot,commandSession.getSnapshot)
  const history=commandState.history,dispatch=commandSession.dispatch
  const project=history.present
  const [loaded,setLoaded]=useState(false)
  const [restoreError,setRestoreError]=useState('')
  const projectRef=useRef(project);projectRef.current=project
  const [assets,setAssets]=useState<Map<string,AudioAsset>>(new Map())
  const assetsRef=useRef(assets);assetsRef.current=assets
  const [focusedTrackId,setFocusedTrackId]=useState(project.tracks[2]?.id??project.tracks[0]?.id??'')
  const [selectedTrackIds,setSelectedTrackIds]=useState<ReadonlySet<string>>(()=>new Set(project.tracks[2]?[project.tracks[2].id]:project.tracks[0]?[project.tracks[0].id]:[]))
  const [selectedClipIds,setSelectedClipIds]=useState<ReadonlySet<string>>(()=>new Set(project.tracks[2]?.clips[0]?[project.tracks[2].clips[0].id]:[]))
  const [anchorClipId,setAnchorClipId]=useState<string|null>(project.tracks[2]?.clips[0]?.id??null)
  const [renamingTrackId,setRenamingTrackId]=useState<string|null>(null)
  const [renamingClipId,setRenamingClipId]=useState<string|null>(null)
  const clipboard=useRef<Clipboard|null>(null)
  const [bottomTab,setBottomTabState]=useState<'editor'|'mixer'|'devices'|'pitch'>('editor')
  const [editorOpenRequest,setEditorOpenRequest]=useState(0)
  const setBottomTab=useCallback((next:SetStateAction<'editor'|'mixer'|'devices'|'pitch'>)=>{setBottomTabState(next);setEditorOpenRequest(value=>value+1)},[])
  const [pitchBusy,setPitchBusy]=useState(false),[pitchDirty,setPitchDirty]=useState(false)
  const pitchBusyRef=useRef(false),pitchDirtyRef=useRef(false)
  const pitchBusyChange=useCallback((value:boolean)=>{pitchBusyRef.current=value;setPitchBusy(value)},[])
  const pitchDirtyChange=useCallback((value:boolean)=>{pitchDirtyRef.current=value;setPitchDirty(value)},[])
  const [zoom,setZoom]=useState<ZoomState>(()=>loadZoom())
  const initialZoom=useRef(zoom)
  const pianoZoom=useRef<ZoomHandle|null>(null),mixerZoom=useRef<ZoomHandle|null>(null),deviceZoom=useRef<ZoomHandle|null>(null)
  const pianoCommand=useRef<((command:ProjectShortcut)=>boolean)|null>(null)
  const lastShortcutEditor=useRef<ShortcutEditScope>('timeline')
  const lastFit=useRef<{ppb:number;kind:'selection'|'all'}|null>(null)
  const patchZoom=useCallback(<K extends keyof ZoomState>(area:K,patch:(z:ZoomState[K])=>Partial<ZoomState[K]>)=>setZoom(z=>({...z,[area]:{...z[area],...patch(z[area])}})),[])
  const ppb=zoom.timeline.ppb
  const setPpb=useCallback((value:number)=>patchZoom('timeline',()=>({ppb:clampZoom(value,ZOOM_LIMITS.timelineX)})),[patchZoom])
  const setRowHeight=useCallback((value:number)=>patchZoom('timeline',()=>({rowHeight:clampZoom(value,ZOOM_LIMITS.timelineY)})),[patchZoom])
  useEffect(()=>{if(zoom===initialZoom.current)return;const id=window.setTimeout(()=>saveZoom(zoom),250);return()=>clearTimeout(id)},[zoom])
  // View toggles persist; with nothing saved yet, a narrow window starts without the library.
  const [view,setView]=useState<ViewState>(()=>{const v=loadView();let saved=false;try{saved=!!localStorage.getItem(VIEW_STORAGE_KEY)}catch{/* no storage */}return saved||window.innerWidth>1250?v:{...v,libraryOpen:false}})
  const initialView=useRef(view)
  useEffect(()=>{if(view!==initialView.current)saveView(view)},[view])
  const patchView=useCallback((patch:Partial<ViewState>)=>setView(v=>({...v,...patch})),[])
  const [trackHeader,setTrackHeader]=useState<TrackHeaderState>(()=>loadTrackHeader())
  const initialHeader=useRef(trackHeader)
  useEffect(()=>{if(trackHeader!==initialHeader.current)saveTrackHeader(trackHeader)},[trackHeader])
  const [trackZoom,setTrackZoom]=useState<TrackZoom>({})
  const trackZoomProject=useRef(project.id)
  useEffect(()=>{if(trackZoomProject.current===project.id)return;trackZoomProject.current=project.id;setTrackZoom(loadTrackZoom(project.id,projectRef.current.tracks.map(t=>t.id)))},[project.id])
  useEffect(()=>{if(loaded)setTrackZoom(z=>pruneTrackZoom(z,project.tracks.map(t=>t.id)))},[loaded,project.tracks])
  useEffect(()=>{if(!loaded||trackZoomProject.current!==project.id)return;const id=window.setTimeout(()=>saveTrackZoom(project.id,trackZoom),250);return()=>clearTimeout(id)},[loaded,trackZoom,project.id])
  const [hideView,setHideView]=useState(false)
  const [soloRecall,setSoloRecall]=useState<string[]|null>(null)
  const [palette,setPalette]=useState<{ids:string[];x:number;y:number}|null>(null)
  const [headerConfig,setHeaderConfig]=useState<{x:number;y:number}|null>(null)
  const [iconMenu,setIconMenu]=useState<{id:string;x:number;y:number}|null>(null)
  const [appMenu,setAppMenu]=useState<{x:number;y:number;trigger:HTMLElement}|null>(null)
  const projectSession=useRef(0)
  const importing=useRef(false)
  const exporting=useRef(false)
  const projectSaveAction=useRef<()=>Promise<void>>(async()=>{})
  const [saveStatus,setSaveStatus]=useState<'loading'|'saving'|'saved'|'error'>('loading')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState('')
  const [modal,setModal]=useState<'new'|'export'|'help'|'about'|'newTracks'|'settings'|'mcp'|null>(null)
  const transportKeyState=useRef({held:false})
  const [instanceId]=useState(()=>uid())
  const [aiEditsAllowed,setAiEditsAllowed]=useState(true)
  const aiEditsAllowedRef=useRef(aiEditsAllowed)
  const activeControlEdits=useRef(new Set<string>())
  useEffect(()=>{
    const active=activeControlEdits.current
    const begin=(id:string,target:Element)=>{active.add(id);commandSession.beginGesture(id,target.getAttribute('aria-label')??undefined)}
    const finish=(id:string)=>{active.delete(id);commandSession.endGesture(id)}
    const down=(event:PointerEvent)=>{const target=event.target instanceof Element?event.target.closest('input[type="range"],[data-track-button]'):null;if(event.button===0&&target)begin(`pointer:${event.pointerId}`,target)}
    const up=(event:PointerEvent)=>finish(`pointer:${event.pointerId}`)
    const keyDown=(event:KeyboardEvent)=>{if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.isComposing&&event.target instanceof Element&&event.target.matches('input[type="range"]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))begin(`key:${event.key}`,event.target)}
    const keyUp=(event:KeyboardEvent)=>finish(`key:${event.key}`)
    const clear=()=>{for(const id of active)commandSession.endGesture(id);active.clear()}
    document.addEventListener('pointerdown',down,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true)
    document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);window.addEventListener('blur',clear)
    return()=>{document.removeEventListener('pointerdown',down,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);window.removeEventListener('blur',clear);clear()}
  },[commandSession])
  useEffect(()=>{
    const remember=(event:Event)=>{if(shortcutScope(event.target)==='dialog')return;const area=shortcutEditorScope(event.target);if(area)lastShortcutEditor.current=area}
    document.addEventListener('pointerdown',remember,true);document.addEventListener('focusin',remember,true)
    return()=>{document.removeEventListener('pointerdown',remember,true);document.removeEventListener('focusin',remember,true)}
  },[])
  useEffect(()=>{lastShortcutEditor.current=bottomTab==='mixer'?'mixer':bottomTab==='devices'?'devices':bottomTab==='editor'&&pianoCommand.current?'piano':'timeline'},[bottomTab])
  const bridgeHandler=useRef<DawBridgeHandler>(()=>{throw new Error('프로젝트를 준비 중입니다.')})
  const [bridgeClient]=useState(()=>new DawBridgeClient((method,params,context)=>bridgeHandler.current(method,params,context)))
  const bridgeState=useSyncExternalStore(bridgeClient.subscribe,bridgeClient.getSnapshot,bridgeClient.getSnapshot)
  useEffect(()=>()=>bridgeClient.disconnect(),[bridgeClient])
  const [audioSettings,setAudioSettings]=useState<AudioSettings>(()=>({...engine.getAudioState().settings}))
  const audioSettingsRef=useRef(audioSettings);audioSettingsRef.current=audioSettings
  const [audioApplying,setAudioApplying]=useState(false)
  const audioApplyingRef=useRef(false)
  const [inputRevision,setInputRevision]=useState(0)
  const [recording,setRecording]=useState(false)
  const [recordingDraft,setRecordingDraft]=useState<RecordingDraft|null>(null)
  const [recordPreparing,setRecordPreparing]=useState(false)
  const recordPreparingRef=useRef(false)
  const recordAttempt=useRef(0)
  const audioInput=useRef<HTMLInputElement>(null)
  const recordRef=useRef<{capture:AudioRecording;stream:MediaStream;draft:RecordingDraft}|null>(null)
  const importTarget=useRef<{trackId?:string;beat?:number}>({})
  const [inputCapture]=useState(()=>new InputCapture(()=>navigator.mediaDevices.getUserMedia(inputConstraints(audioSettingsRef.current,projectRef.current.sampleRate))))
  const monitorWarned=useRef(false)
  const saveQueue=useRef(Promise.resolve())
  const saveTimer=useRef<number|null>(null)
  const saveRevision=useRef(0)
  const persistedProject=useRef<Project|null>(null)
  const persistedAssets=useRef<Map<string,AudioAsset>|null>(null)
  const persistedRevision=useRef(-1)
  const navigationGuard=useRef<()=>Promise<boolean>>(async()=>false)
  const focusedTrack=project.tracks.find(t=>t.id===focusedTrackId)
  const clipIndex=useMemo(()=>{const map=new Map<string,ClipEntry>();project.tracks.forEach((track,row)=>track.clips.forEach(clip=>map.set(clip.id,{clip,track,row})));return map},[project])
  const projectClipIds=useMemo(()=>new Set(clipIndex.keys()),[clipIndex])
  const anchorEntry=anchorClipId?clipIndex.get(anchorClipId):undefined
  // The anchor (last selected clip) drives the editor; the set drives edits.
  const selectedClip=anchorEntry&&anchorEntry.track.id===focusedTrackId?anchorEntry.clip:undefined
  const selection=[...selectedClipIds].map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e).sort((a,b)=>a.clip.startBeat-b.clip.startBeat||a.row-b.row)
  const snapStep=resolveSnap(view.snap,ppb,.25,project.beatsPerBar,quarterNotesPerBeat(project.timeSignature))
  const monitorIds=useMemo(()=>audioSettings.softwareMonitoring?monitorTargets(project,recording):[],[project,recording,audioSettings.softwareMonitoring])

  const notify=useCallback((message:string)=>setNotice(message),[])
  useEffect(()=>{pitchDirtyChange(reconcilePitchDrafts(project.id,project.tracks.flatMap(track=>track.clips),project.bpm,notify))},[project,pitchDirtyChange,notify])
  const commit=commandSession.edit
  const breakHistoryMerge=commandSession.breakMerge
  function pitchPending(){
    if(!pitchBusyRef.current&&!pitchDirtyRef.current)return false
    notify(pitchBusyRef.current?'피치 분석·렌더가 끝나거나 취소된 뒤 진행해 주세요.':'미적용 피치 편집이 있습니다. 피치 편집기에서 적용하거나 변경을 취소해 주세요.')
    const pendingId=firstPitchDraftId(project.id),pending=pendingId?clipIndex.get(pendingId):undefined
    if(pending)selectClips([pending.clip.id],pending.clip.id,pending.track.id)
    setBottomTab('pitch')
    return true
  }
  async function applyPitchEdit(result:PitchRenderedEdit,expectedClip:AudioClip,signal?:AbortSignal){
    if(signal?.aborted)throw new DOMException('피치 적용을 취소했습니다.','AbortError')
    if(recordRef.current||recordPreparingRef.current||audioApplyingRef.current||busy||importing.current)throw new Error('녹음·오디오 설정·파일 처리가 끝난 뒤 피치 편집을 적용해 주세요.')
    const snapshot=commandSession.getSnapshot(),epoch=projectSession.current
    const current=()=>commandSession.getSnapshot().history.present.tracks.flatMap(t=>t.clips).find(c=>c.id===expectedClip.id)
    if(current()!==expectedClip)throw new Error('리전이 변경되었습니다. 최신 상태에서 다시 적용해 주세요.')
    const document=validatePitchDocument(result.document)
    const source=assetsRef.current.get(document.sourceAssetId)
    if(!source)throw new Error('피치 편집 원본 음원이 없습니다.')
    if(document.sourceAssetId!==(expectedClip.pitch?.sourceAssetId??expectedClip.assetId))throw new Error('피치 편집 원본이 변경되었습니다.')
    assertPitchSourceTiming(document,source.buffer.sampleRate,source.buffer.length)
    if(result.sampleRate!==source.buffer.sampleRate||result.channels.length!==source.buffer.numberOfChannels||result.channels.some(channel=>channel.length!==source.buffer.length))throw new Error('피치 처리 결과의 길이·채널·샘플레이트가 원본과 다릅니다.')
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await source.blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('')
    if(hash!==document.sourceHash)throw new Error('피치 분석과 원본 파일이 일치하지 않습니다. 원본을 다시 분석해 주세요.')
    if(signal?.aborted)throw new DOMException('피치 적용을 취소했습니다.','AbortError')
    const changed=hasPitchAudioEdits(document)
    const rendered=changed?await engine.decodeAsset(encodePitchWav(result.channels,result.sampleRate),`${source.name} · 피치`):source
    if(signal?.aborted)throw new DOMException('피치 적용을 취소했습니다.','AbortError')
    if(recordRef.current||recordPreparingRef.current||audioApplyingRef.current||importing.current)throw new Error('처리 중 녹음·오디오 설정·가져오기가 시작되어 피치 적용을 취소했습니다. 작업이 끝난 뒤 다시 적용해 주세요.')
    if(projectSession.current!==epoch||commandSession.getSnapshot().revision!==snapshot.revision||current()!==expectedClip||assetsRef.current.get(source.id)!==source)throw new Error('처리 중 프로젝트가 변경되어 피치 적용을 취소했습니다. 다시 적용해 주세요.')
    const nextClip=applyPitchDocument(expectedClip,document,rendered.id)
    const nextAssets=new Map(assetsRef.current);nextAssets.set(rendered.id,rendered)
    // Install immutable audio before publishing the project that references it.
    engine.setAssets(nextAssets);assetsRef.current=nextAssets;setAssets(nextAssets)
    // This deliberate apply replaces the draft's base; it is not an external conflict.
    pitchDrafts.delete(expectedClip.id)
    breakHistoryMerge();commit(p=>mapClips(p,new Set([expectedClip.id]),()=>nextClip));breakHistoryMerge()
    notify(changed?'피치·포먼트 편집을 적용했습니다. 재생과 WAV 출력에 같은 결과가 사용됩니다.':'피치 분석·음표 경계·처리 설정을 저장했습니다. 원본 소리를 유지합니다.')
  }
  function resetPitchEdit(expectedClip:AudioClip){
    const current=commandSession.getSnapshot().history.present.tracks.flatMap(t=>t.clips).find(c=>c.id===expectedClip.id)
    if(current!==expectedClip||!expectedClip.pitch||!assetsRef.current.has(expectedClip.pitch.sourceAssetId))return
    pitchDrafts.delete(expectedClip.id)
    breakHistoryMerge();commit(p=>mapClips(p,new Set([expectedClip.id]),()=>restorePitchSource(expectedClip)));breakHistoryMerge()
    notify('원본 음원으로 복원했습니다. 실행 취소로 피치 편집을 다시 가져올 수 있습니다.')
  }
  bridgeHandler.current=createDawRequestHandler({
    session:commandSession,
    getSelection:()=>({focusedTrackId,trackIds:[...selectedTrackIds],clipIds:[...selectedClipIds]}),
    getTransport:()=>engine.getSnapshot(),
    getRuntime:()=>{
      const active=document.activeElement
      const textEditing=active instanceof HTMLElement&&!active.closest('.mcp-connection')&&active.matches('input:not([type="checkbox"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="file"]),textarea,select,[contenteditable="true"]')
      const blockedReason=navigating?'프로젝트를 저장하고 이동하는 중입니다.':pitchBusyRef.current||pitchDirtyRef.current?'피치 작업을 적용하거나 취소한 뒤 AI 편집을 사용할 수 있습니다.':recordRef.current||recordPreparingRef.current?'녹음·녹음 준비가 끝난 뒤 편집할 수 있습니다.':audioApplyingRef.current||busy||importing.current?'오디오 설정이나 파일 처리가 끝난 뒤 편집할 수 있습니다.':(modal&&modal!=='mcp')||document.querySelector('[data-guitar-rig-dialog]')?'열린 대화상자를 닫은 뒤 편집할 수 있습니다.':activeControlEdits.current.size||commandSession.isGestureActive()||document.querySelector('[data-daw-gesture]')||textEditing?'현재 입력·드래그가 끝난 뒤 편집할 수 있습니다.':null
      const current=commandSession.getSnapshot()
      return{ready:loaded&&!restoreError,editsAllowed:aiEditsAllowedRef.current,blockedReason,persistence:!loaded?'loading':saveStatus==='error'?'error':saveStatus==='saved'&&persistedProject.current===current.history.present&&persistedRevision.current===current.revision?'saved':'pending'}
    },
    onMutation:summary=>{
      projectRef.current=commandSession.getSnapshot().history.present
      try{engine.setProject(projectRef.current);notify(`AI · ${summary}`)}
      catch(error){notify(`AI 편집은 적용됐지만 오디오 갱신에 실패했습니다: ${error instanceof Error?error.message:'오디오 상태를 확인해주세요.'}`);throw error}
    },
  })
  const changeHistory=useCallback((type:'undo'|'redo')=>{
    if(audioApplyingRef.current)return
    const target=type==='undo'?history.past.at(-1):history.future[0]
    if((recordRef.current||recordPreparingRef.current)&&target&&target.sampleRate!==projectRef.current.sampleRate){notify('샘플레이트를 바꾸는 실행 취소·다시 실행은 녹음이 끝난 뒤 사용할 수 있습니다.');return}
    breakHistoryMerge();dispatch({type})
  },[breakHistoryMerge,history.past,history.future,notify])
  /** Patches that only touch armed/monitor bypass history (live state). */
  const changeTracks=useCallback((patches:{id:string;patch:Partial<Track>}[],key='')=>{
    if(!patches.length)return
    const edit=(p:Project)=>{let changed=false;const tracks=p.tracks.map(t=>{const m=patches.find(x=>x.id===t.id);if(!m||!Object.entries(m.patch).some(([k,v])=>t[k as keyof Track]!==v))return t;changed=true;return{...t,...m.patch}});return changed?{...p,tracks}:p}
    const label=Object.keys(patches[0].patch).map(k=>TRACK_EDIT_LABELS[k as keyof Track]).find(Boolean)??'트랙 설정 변경'
    if(patches.every(x=>Object.keys(x.patch).every(k=>LIVE_KEYS.has(k as keyof Track))))dispatch({type:'live',edit});else commit(edit,key,label)
  },[commit])
  const changeTrack=useCallback((id:string,patch:Partial<Track>,key=`${id}:${Object.keys(patch).join(',')}`)=>changeTracks([{id,patch}],key),[changeTracks])
  const editTrack=useCallback((id:string,edit:(t:Track)=>Track,key='',label='디바이스 편집')=>commit(p=>{let changed=false;const tracks=p.tracks.map(t=>{if(t.id!==id)return t;const next=edit(t);changed=next!==t;return next});return changed?{...p,tracks}:p},key,label),[commit])
  const changeInstrument=(id:string,instrument:InstrumentId)=>editTrack(id,t=>withInstrument(t,instrument),undefined,'악기 변경')
  const toggleDevice=(id:string,deviceId:string)=>editTrack(id,t=>({...t,devices:t.devices.map(d=>d.id===deviceId?{...d,enabled:!d.enabled}:d)}))
  function addDevice(id:string,type:EffectType){const device=createDevice(type);editTrack(id,t=>({...t,devices:[...t.devices,device]}))}
  function previewTrack(track:Track){void engine.previewNote(track.instrument,previewPitch(instrumentDef(track.instrument)),.8,track.id).catch(e=>notify(String(e)))}
  function previewInstrument(instrument:InstrumentId){void engine.previewNote(instrument,previewPitch(instrumentDef(instrument))).catch(e=>notify(String(e)))}
  function changeClip(clip:Clip,key='',label=clip.kind==='midi'?'음표 편집':key.endsWith(':gain')?'리전 게인 조절':key.includes(':fade')?'리전 페이드 조절':'리전 편집'){commit(p=>mapClips(p,new Set([clip.id]),()=>clip),key,label)}
  const firstClip=(ids:string[])=>ids.map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e).sort((a,b)=>a.clip.startBeat-b.clip.startBeat||a.row-b.row)[0]?.clip.id??null
  /** Clip selection focuses the anchor's track and makes it the only selected track. */
  function selectClips(ids:string[],anchor:string|null=ids.at(-1)??null,trackId?:string){
    breakHistoryMerge();setSelectedClipIds(new Set(ids));setAnchorClipId(anchor)
    const owner=trackId??(anchor?clipIndex.get(anchor)?.track.id:undefined)
    if(owner){setFocusedTrackId(owner);setSelectedTrackIds(new Set([owner]))}
  }
  function focusTrack(id:string,ids:Iterable<string>=[id],clearClips=true){breakHistoryMerge();setFocusedTrackId(id);setSelectedTrackIds(new Set(ids));if(clearClips){setSelectedClipIds(new Set());setAnchorClipId(null)}}
  /** Header click (A-01…A-04): plain = this track and its cycle-aware clips, range = span from the focused track, toggle = add/remove, trackOnly = leave clips alone. */
  function trackClick(id:string,{range,toggle,trackOnly}:TrackMods){
    const track=project.tracks.find(t=>t.id===id);if(!track)return
    breakHistoryMerge()
    const clipsOf=(ids:string[])=>ids.flatMap(tid=>{const t=project.tracks.find(x=>x.id===tid);return t?cycleClipIds(t,project.loop):[]})
    if(range){
      const order=visibleTracks(project,hideView).map(t=>t.id);const b=order.indexOf(id);let a=order.indexOf(focusedTrackId);if(a<0)a=b
      const span=order.slice(Math.min(a,b),Math.max(a,b)+1);setSelectedTrackIds(new Set(span))
      if(!trackOnly){const ids=clipsOf(span);setSelectedClipIds(new Set(ids));setAnchorClipId(anchorClipId&&ids.includes(anchorClipId)?anchorClipId:firstClip(ids))}
      return
    }
    if(toggle){
      const next=new Set(selectedTrackIds)
      if(next.has(id)&&next.size>1){
        next.delete(id);const own=new Set(track.clips.map(c=>c.id))
        if(!trackOnly){const rest=[...selectedClipIds].filter(c=>!own.has(c));setSelectedClipIds(new Set(rest));if(anchorClipId&&own.has(anchorClipId))setAnchorClipId(firstClip(rest))}
        if(focusedTrackId===id){const top=project.tracks.find(t=>next.has(t.id));if(top)setFocusedTrackId(top.id)}
      }else{
        next.add(id);setFocusedTrackId(id)
        if(!trackOnly){const ids=cycleClipIds(track,project.loop);setSelectedClipIds(new Set([...selectedClipIds,...ids]));setAnchorClipId(firstClip(ids)??anchorClipId)}
      }
      setSelectedTrackIds(next);return
    }
    setFocusedTrackId(id);setSelectedTrackIds(new Set([id]))
    if(!trackOnly){const ids=cycleClipIds(track,project.loop);setSelectedClipIds(new Set(ids));setAnchorClipId(anchorClipId&&ids.includes(anchorClipId)?anchorClipId:firstClip(ids))}
  }
  function trackFocus(id:string){if(!project.tracks.some(t=>t.id===id))return;breakHistoryMerge();setFocusedTrackId(id);if(!selectedTrackIds.has(id))setSelectedTrackIds(new Set([id]))}
  /** ↑/↓ moves focus to the neighbouring shown track; Shift grows the selection instead of replacing it. */
  function moveFocus(dir:1|-1,extend:boolean){
    const shown=visibleTracks(project,hideView);const i=shown.findIndex(t=>t.id===focusedTrackId);const next=shown[i<0?0:i+dir];if(!next)return
    breakHistoryMerge();setFocusedTrackId(next.id)
    if(extend)setSelectedTrackIds(new Set([...selectedTrackIds,next.id]));else{setSelectedTrackIds(new Set([next.id]));setSelectedClipIds(new Set());setAnchorClipId(null)}
  }
  function selectFromMarquee(ids:string[],anchor:string|null,trackId?:string){const a=anchor??(anchorClipId&&ids.includes(anchorClipId)?anchorClipId:firstClip(ids));selectClips(ids,a,trackId??(a?clipIndex.get(a)?.track.id:undefined))}
  // Undo/redo or deletion can remove selected clips and tracks: drop them and keep the focus valid.
  useEffect(()=>{
    const ids=[...selectedClipIds].filter(id=>clipIndex.has(id))
    if(ids.length!==selectedClipIds.size)setSelectedClipIds(new Set(ids))
    if(anchorClipId&&!clipIndex.has(anchorClipId))setAnchorClipId(ids.at(-1)??null)
    const tracks=[...selectedTrackIds].filter(id=>project.tracks.some(t=>t.id===id))
    const focus=project.tracks.some(t=>t.id===focusedTrackId)?focusedTrackId:tracks[0]??project.tracks[0]?.id??''
    if(focus!==focusedTrackId)setFocusedTrackId(focus)
    if(tracks.length!==selectedTrackIds.size||!tracks.length)setSelectedTrackIds(new Set(tracks.length?tracks:focus?[focus]:[]))
    if(renamingTrackId&&!project.tracks.some(t=>t.id===renamingTrackId))setRenamingTrackId(null)
    if(renamingClipId&&!clipIndex.has(renamingClipId))setRenamingClipId(null)
  },[clipIndex])

  useEffect(()=>{engine.setProject(commandSession.getSnapshot().history.present)},[project,commandSession])
  // Opening a project or undoing its sample rate must also update an existing context.
  useEffect(()=>{
    const state=engine.getAudioState()
    if(!loaded||audioApplying||recording||recordPreparing||busy||state.sampleRate===null||state.sampleRate===project.sampleRate)return
    let cancelled=false
    engine.pause()
    void engine.configure(audioSettingsRef.current,project.sampleRate).catch(error=>{if(!cancelled)notify(`프로젝트 오디오 설정을 적용하지 못했습니다: ${error instanceof Error?error.message:''}`)})
    return()=>{cancelled=true}
  },[project.sampleRate,loaded,audioApplying,recording,recordPreparing,busy,notify])
  useEffect(()=>{engine.setAssets(assets)},[assets])
  useEffect(()=>{
    let cancelled=false
    void(async()=>{try{
      const saved=await loadProject(projectId)
      if(cancelled)return
      if(!saved)throw new Error(`${desktop?'이 컴퓨터':'이 브라우저'}에 해당 프로젝트가 없습니다. 프로젝트 목록에서 선택하거나 .garak 파일을 가져와 주세요.`)
      // Decoding must use this project's rate, including persisted pitch sources.
      engine.setProject(saved.project)
      const decoded=await Promise.all(saved.assets.map(a=>engine.decodeAsset(a.blob,a.name,a.id)))
      if(cancelled)return
      const next=new Map(decoded.map(a=>[a.id,a]))
      engine.setAssets(next);setAssets(next);assetsRef.current=next
      breakHistoryMerge();dispatch({type:'reset',project:saved.project})
      const state=commandSession.getSnapshot()
      persistedProject.current=state.history.present;persistedRevision.current=state.revision;persistedAssets.current=next
      setTrackZoom(loadTrackZoom(saved.project.id,saved.project.tracks.map(track=>track.id)))
      const first=saved.project.tracks[0]
      if(first?.clips[0])selectClips([first.clips[0].id],first.clips[0].id,first.id);else focusTrack(first?.id??'')
      setSaveStatus('saved');setLoaded(true)
    }catch(error){if(!cancelled){setRestoreError(error instanceof Error?error.message:'저장소 오류');setSaveStatus('error')}}})()
    return()=>{cancelled=true}
  },[projectId,notify])
  useEffect(()=>{document.title=loaded?`${project.name} · ${BRAND.name}`:`프로젝트 열기 · ${BRAND.name}`},[loaded,project.name])
  useEffect(()=>{
    if(!loaded)return
    if(persistedProject.current===project&&persistedAssets.current===assets&&persistedRevision.current===commandState.revision)return
    const revision=++saveRevision.current;setSaveStatus('saving')
    const timer=window.setTimeout(()=>{saveTimer.current=null;saveQueue.current=saveQueue.current.catch(()=>{}).then(async()=>{try{await saveProject(project,assets);if(saveRevision.current===revision){persistedProject.current=project;persistedRevision.current=commandState.revision;persistedAssets.current=assets;setSaveStatus('saved')}}catch(error){if(saveRevision.current===revision){setSaveStatus('error');notify(`자동 저장 실패: ${error instanceof Error?error.message:'저장 공간을 확인해주세요'}. 프로젝트 파일로 내보내 보관해주세요.`)}}})},650)
    saveTimer.current=timer
    return()=>{window.clearTimeout(timer);if(saveTimer.current===timer)saveTimer.current=null}
  },[project,assets,commandState.revision,loaded,notify])
  navigationGuard.current=async()=>{
    if(!loaded){engine.stop();return true}
    // Commit an inline name/number before taking the final snapshot. Pitch inputs
    // may become dirty on blur, so check their draft guard afterwards.
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
    if(pitchPending())return false
    if(recordRef.current||recordPreparingRef.current||busy||importing.current||exporting.current||audioApplyingRef.current||pitchBusyRef.current||activeControlEdits.current.size||commandSession.isGestureActive()||document.querySelector('[data-daw-gesture]')){
      notify(desktop?'녹음·파일 처리·드래그가 끝난 뒤 프로젝트를 이동하거나 앱을 닫아 주세요.':'녹음·파일 처리·드래그가 끝난 뒤 프로젝트를 이동해 주세요.');return false
    }
    if(saveTimer.current!==null){window.clearTimeout(saveTimer.current);saveTimer.current=null}
    const snapshot=commandSession.getSnapshot(),originals=assetsRef.current,revision=++saveRevision.current
    try{
      // Always finish with this snapshot. A queued older autosave may still be
      // writing even after undo returned to the previously persisted object.
      setSaveStatus('saving')
      const saving=saveQueue.current.catch(()=>{}).then(()=>saveProject(snapshot.history.present,originals))
      saveQueue.current=saving;await saving
      if(commandSession.getSnapshot().revision!==snapshot.revision||assetsRef.current!==originals){
        notify('저장 중 프로젝트가 변경되었습니다. 변경을 저장한 뒤 다시 이동해 주세요.');return false
      }
      if(saveRevision.current===revision){persistedProject.current=snapshot.history.present;persistedRevision.current=snapshot.revision;persistedAssets.current=originals;setSaveStatus('saved')}
      engine.stop();return true
    }catch(error){setSaveStatus('error');notify(`프로젝트를 저장하지 못해 이동을 멈췄습니다: ${error instanceof Error?error.message:'저장소 오류'}. 현재 작업을 .garak 파일로 보관할 수 있습니다.`);return false}
  }
  useEffect(()=>registerNavigationGuard(()=>navigationGuard.current()),[registerNavigationGuard])
  projectSaveAction.current=saveBundle
  useEffect(()=>registerProjectSave(()=>projectSaveAction.current()),[registerProjectSave])
  useEffect(()=>{if(navigationError)notify(navigationError)},[navigationError,notify])
  useEffect(()=>{if(!notice)return;const id=window.setTimeout(()=>setNotice(''),7000);return()=>clearTimeout(id)},[notice])
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{
    if(!loaded)return
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
    const state=commandSession.getSnapshot()
    if(persistedRevision.current!==state.revision||persistedProject.current!==state.history.present||persistedAssets.current!==assetsRef.current||saveStatus!=='saved'||recordRef.current||recordPreparingRef.current||busy||pitchDirtyRef.current||pitchBusyRef.current){event.preventDefault();event.returnValue=''}
  };window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[loaded,saveStatus,busy,commandSession])
  useEffect(()=>{const hide=()=>pausePlaybackWithRecording(engine,{cancelPreparation:cancelRecordPreparation,finishRecording});window.addEventListener('pagehide',hide);return()=>window.removeEventListener('pagehide',hide)},[])
  useEffect(()=>bindRecordingToTransport(engine,finishRecording),[engine])

  // Recording preparation owns input too, before MediaRecorder has been created.
  useEffect(()=>()=>{
    projectSession.current+=1
    engine.dispose()
    recordAttempt.current+=1
    recordPreparingRef.current=false
    const active=recordRef.current
    recordRef.current=null
    active?.capture.dispose()
    engine.setInputMonitor(null,[])
    inputCapture.dispose()
  },[inputCapture])
  const clearMonitorFlags=useCallback(()=>dispatch({type:'live',edit:p=>p.tracks.some(t=>t.monitor)?{...p,tracks:p.tracks.map(t=>t.monitor?{...t,monitor:false}:t)}:p}),[])
  useEffect(()=>inputCapture.subscribeInputState(()=>{
    const state=inputCapture.getInputState()
    if(state.status!=='error')return
    engine.setInputMonitor(null,[])
    inputCapture.setNeeded('monitor',false)
    clearMonitorFlags()
    notify(`오디오 입력을 확인해주세요: ${state.error??'입력 장치에 연결하지 못했습니다.'}`)
  }),[inputCapture,clearMonitorFlags,notify])
  useEffect(()=>{
    let previous:string|null=null
    return engine.subscribeAudioState(()=>{const state=engine.getAudioState();if(state.error&&state.error!==previous)notify(`오디오 장치를 확인해주세요: ${state.error}`);previous=state.error})
  },[notify])
  const monitorKey=monitorIds.join('\n')
  useEffect(()=>{
    if(audioApplying)return
    engine.setInputMonitor(null,[])
    inputCapture.setNeeded('monitor',monitorIds.length>0)
    if(!monitorIds.length)return
    if(!navigator.mediaDevices?.getUserMedia){inputCapture.setNeeded('monitor',false);notify(desktop?'이 컴퓨터에서는 입력 모니터링을 사용할 수 없습니다.':'이 브라우저에서는 입력 모니터링을 사용할 수 없습니다.');clearMonitorFlags();return}
    let cancelled=false
    void(async()=>{try{await engine.resume();if(cancelled||audioApplyingRef.current)return;const stream=await inputCapture.acquire();if(cancelled||audioApplyingRef.current)return;engine.setInputMonitor(stream,monitorIds);if(!monitorWarned.current&&projectRef.current.tracks.some(t=>t.monitor)){monitorWarned.current=true;notify('피드백을 막으려면 헤드폰을 사용하세요')}}catch(e){if(cancelled||audioApplyingRef.current)return;inputCapture.setNeeded('monitor',false);notify(`입력 모니터링을 시작하지 못했습니다: ${e instanceof Error?e.message:'마이크 접근을 확인해주세요'}`);clearMonitorFlags()}})()
    return()=>{cancelled=true}
  },[monitorKey,inputCapture,inputRevision,audioApplying])

  function openAudioSettings(){setAppMenu(null);setPalette(null);setHeaderConfig(null);setIconMenu(null);setModal('settings')}
  async function applyAudioSettings(value:AudioSettings,sampleRate:SampleRate):Promise<{persisted:boolean}>{
    if(pitchBusyRef.current)throw new Error('피치 분석·렌더가 끝나거나 취소된 뒤 오디오 설정을 적용해 주세요.')
    if(audioApplyingRef.current||recordRef.current||recordPreparingRef.current||busy||importing.current)throw new Error('녹음이나 파일 처리가 끝난 뒤 오디오 설정을 적용해주세요.')
    const next=normalizeAudioSettings(value),previous=audioSettingsRef.current,previousRate=projectRef.current.sampleRate
    const session=projectSession.current
    const previousTargets=previous.softwareMonitoring?monitorTargets(projectRef.current,false):[]
    const nextTargets=next.softwareMonitoring?monitorTargets(projectRef.current,false):[]
    let prepared:Awaited<ReturnType<InputCapture['prepare']>>|undefined
    let configured=false
    audioApplyingRef.current=true;setAudioApplying(true);setBusy('오디오 설정을 적용하는 중…');engine.pause()
    try{
      const inputChanged=JSON.stringify(inputConstraints(next,sampleRate))!==JSON.stringify(inputConstraints(previous,previousRate))
      if(nextTargets.length&&(inputChanged||inputCapture.getInputState().status!=='active')){
        inputCapture.setNeeded('monitor',true)
        prepared=await inputCapture.prepare(()=>navigator.mediaDevices.getUserMedia(inputConstraints(next,sampleRate)))
      }
      if(session!==projectSession.current)throw new DOMException('오디오 설정 적용이 취소되었습니다.','AbortError')
      await engine.configure(next,sampleRate);configured=true
      if(session!==projectSession.current)throw new DOMException('오디오 설정 적용이 취소되었습니다.','AbortError')
      prepared?.commit();prepared=undefined
      audioSettingsRef.current=next;setAudioSettings(next)
      engine.setInputMonitor(null,[])
      if(!nextTargets.length)inputCapture.setNeeded('monitor',false)
      if(sampleRate!==projectRef.current.sampleRate){breakHistoryMerge();commit(p=>({...p,sampleRate}),'project-sample-rate')}
      setInputRevision(revision=>revision+1)
      return{persisted:saveAudioSettings(next)}
    }catch(error){
      prepared?.rollback()
      if(!previousTargets.length)inputCapture.setNeeded('monitor',false)
      if(configured&&session===projectSession.current){
        try{await engine.configure(previous,previousRate)}catch(rollbackError){
          const actual=engine.getAudioState().settings
          audioSettingsRef.current=actual;setAudioSettings(actual)
          engine.setInputMonitor(null,[]);inputCapture.setNeeded('monitor',false);clearMonitorFlags()
          throw new Error(`입력 변경 후 이전 출력 설정으로 복구하지 못해 모니터링을 중지했습니다. 장치를 다시 확인해주세요. ${rollbackError instanceof Error?rollbackError.message:''}`)
        }
      }
      throw error
    }finally{
      audioApplyingRef.current=false
      if(session===projectSession.current){setAudioApplying(false);setBusy('')}
    }
  }

  async function playTransport(action:'toggle'|'start'='toggle'){
    if(audioApplyingRef.current)return
    if(action==='start'&&(recordPreparingRef.current||recordRef.current))return
    try{if(action==='start')await engine.play();else await togglePlaybackWithRecording(engine,{cancelPreparation:cancelRecordPreparation,finishRecording})}
    catch(e){notify(`오디오를 시작할 수 없습니다: ${e instanceof Error?e.message:''}`)}
  }
  function cancelRecordPreparation():boolean{
    if(!recordPreparingRef.current||recordRef.current)return false
    recordAttempt.current+=1;recordPreparingRef.current=false;setRecordPreparing(false);inputCapture.setNeeded('record',false)
    return true
  }
  function finishRecording():boolean{
    const active=recordRef.current
    if(!active)return false
    if(active.draft.status==='recording'){
      active.draft={...active.draft,status:'processing',elapsedSeconds:active.capture.elapsedSeconds}
      setRecordingDraft(active.draft);setRecording(false)
      // Keep ownership until the final dataavailable/stop events and decoding have completed.
      active.capture.stop()
    }
    return true
  }
  function stop(){stopPlaybackWithRecording(engine,{cancelPreparation:cancelRecordPreparation,finishRecording})}
  function seekPlay(beat:number){if(recordPreparingRef.current||recordRef.current)return;engine.seek(Math.max(0,beat));if(!engine.getSnapshot().playing)void playTransport('start')}
  function addMidiClip(trackId:string,beat:number){
    const track=project.tracks.find(t=>t.id===trackId);if(!track)return
    if(track.kind==='audio'){importTarget.current={trackId,beat};audioInput.current?.click();return}
    const clip:MidiClip={kind:'midi',id:uid(),name:'새 패턴',startBeat:Math.max(0,beat),lengthBeats:project.beatsPerBar*2,gain:1,notes:[]}
    commit(p=>fitProjectLength({...p,tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:[...t.clips,clip]}:t)}));selectClips([clip.id],clip.id,trackId);setBottomTab('editor')
  }
  const playhead=()=>engine.getSnapshot().beat
  const audioMax=(clip:Clip)=>{if(clip.kind!=='audio')return Infinity;const asset=assets.get(clip.assetId);return asset?Math.max(.0625,(asset.buffer.duration-clip.offsetSeconds)*project.bpm/60):Infinity}
  const idsOf=(entries:ClipEntry[])=>new Set(entries.map(e=>e.clip.id))
  const entriesOf=(ids:string[])=>ids.map(id=>clipIndex.get(id)).filter((e):e is ClipEntry=>!!e)
  const selectionStart=(s=selection)=>Math.min(...s.map(e=>e.clip.startBeat))
  const selectionEnd=(s=selection)=>Math.max(...s.map(e=>e.clip.startBeat+e.clip.lengthBeats))
  /** Logic Drag mode: in "no overlap", clips that a moved or resized clip now covers get trimmed, split or removed. */
  const withDragMode=(next:Project,made:{trackId:string;clip:Clip}[])=>applyDragMode(next,[...new Set(made.map(m=>m.trackId))],made.map(m=>m.clip.id),view.dragMode)
  // Clip commands derive the next project from the rendered one, so IDs generated here
  // stay identical when StrictMode replays the reducer.
  function apply(next:Project,key='',label='리전 편집'){if(next!==project)commit(()=>fitProjectLength(next),key,label)}
  function requireSelection(message='먼저 클립을 선택해주세요.',s=selection){if(s.length)return true;notify(message);return false}
  function selectNew(made:{trackId:string;clip:Clip;from?:string}[]){if(!made.length)return;const anchor=made.find(m=>m.from!==undefined&&m.from===anchorClipId)??made.at(-1)!;selectClips(made.map(m=>m.clip.id),anchor.clip.id,anchor.trackId)}
  function editSelection(fn:(clip:Clip)=>Clip,opts:{filter?:(e:ClipEntry)=>boolean;empty?:string;key?:string;drag?:boolean;entries?:ClipEntry[]}={}){
    const targets=(opts.entries??selection).filter(opts.filter??(()=>true));if(!targets.length){notify(opts.empty??'먼저 클립을 선택해주세요.');return}
    let next=mapClips(project,idsOf(targets),fn)
    if(opts.drag&&next!==project){const moved=new Set(targets.map(e=>e.clip.id));next=withDragMode(next,next.tracks.flatMap(t=>t.clips.filter(c=>moved.has(c.id)).map(clip=>({trackId:t.id,clip}))))}
    apply(next,opts.key)
  }
  function moveClips(moves:ClipMove[],copy:boolean){
    const items=moves.map(m=>({m,e:clipIndex.get(m.clipId)})).filter((x):x is {m:ClipMove;e:ClipEntry}=>!!x.e);if(!items.length)return
    const made=items.map(({m,e})=>{const target=project.tracks.find(t=>t.id===(m.toTrackId??m.trackId))??e.track;const start=Math.max(0,m.start);const base=m.length!==undefined?trimClipEnd(e.clip,e.clip.startBeat+m.length,audioMax(e.clip)):e.clip;return{from:e.clip.id,target,source:e.track,clip:copy?duplicateClip(base,start):{...base,startBeat:start}}})
    if(made.some(x=>x.target.kind!==x.source.kind))return
    const additions=made.map(x=>({trackId:x.target.id,clip:x.clip}))
    apply(withDragMode(addClips(copy?project:mapClips(project,idsOf(items.map(x=>x.e)),()=>null),additions),additions),'',copy?'리전 복사':moves.some(m=>m.length!==undefined)?'리전 길이 조절':'리전 이동')
    if(copy)selectNew(made.map(x=>({trackId:x.target.id,clip:x.clip,from:x.from})))
    else{const a=made.find(x=>x.from===anchorClipId);if(a&&a.target.id!==focusedTrackId){setFocusedTrackId(a.target.id);setSelectedTrackIds(new Set([a.target.id]))}}
  }
  function trimStart(trims:readonly ClipStartTrim[]){apply(trimClipStarts(project,trims,view.dragMode),'','리전 시작점 조절')}
  function deleteClips(entries=selection){if(!entries.length)return;apply(mapClips(project,idsOf(entries),()=>null),'','리전 삭제');breakHistoryMerge();setSelectedClipIds(new Set());setAnchorClipId(null)}
  function copySelection(){if(!requireSelection('복사할 클립을 선택해주세요.'))return false;clipboard.current={items:selection.map(e=>({clip:e.clip,row:e.row,kind:e.track.kind})),base:selectionStart(),topRow:Math.min(...selection.map(e=>e.row))};return true}
  /** Pastes at the playhead, keeping relative timing and track offsets when the kinds match. */
  function paste(){
    const board=clipboard.current;if(!board?.items.length){notify('붙여넣을 클립이 없습니다. 먼저 복사해주세요.');return}
    const targetRow=project.tracks.findIndex(t=>t.id===focusedTrackId);if(targetRow<0){notify('붙여넣을 트랙을 선택해주세요.');return}
    const beat=Math.max(0,playhead()),made:{trackId:string;clip:Clip}[]=[]
    for(const item of board.items){let track=project.tracks[targetRow+item.row-board.topRow];if(!track||track.kind!==item.kind)track=project.tracks[targetRow];if(track.kind!==item.kind)continue;made.push({trackId:track.id,clip:duplicateClip(item.clip,beat+item.clip.startBeat-board.base)})}
    if(!made.length){notify(`${board.items[0].kind==='audio'?'오디오':'MIDI'} 클립은 같은 종류의 트랙에만 붙여넣을 수 있습니다.`);return}
    apply(withDragMode(addClips(project,made),made),'','리전 붙여넣기');selectNew(made)
  }
  function duplicateSelection(){if(!requireSelection('복제할 클립을 선택해주세요.'))return;const span=selectionEnd()-selectionStart();const made=selection.map(e=>({trackId:e.track.id,clip:duplicateClip(e.clip,e.clip.startBeat+span),from:e.clip.id}));apply(withDragMode(addClips(project,made),made),'','리전 반복');selectNew(made)}
  function splitSelection(){
    const beat=playhead(),candidates=selection.length?selection:(focusedTrack?.clips??[]).map(c=>clipIndex.get(c.id)).filter((e):e is ClipEntry=>!!e)
    const parts=new Map<string,{trackId:string;clips:Clip[]}>()
    for(const e of candidates){const r=splitClip(e.clip,beat,project.bpm);if(r.length===2)parts.set(e.clip.id,{trackId:e.track.id,clips:r})}
    if(!parts.size){notify('재생 커서가 지나가는 클립을 선택한 뒤 분할해주세요.');return}
    apply(mapClips(project,new Set(parts.keys()),c=>parts.get(c.id)!.clips),'','리전 분할')
    selectNew([...parts.entries()].map(([from,v])=>({trackId:v.trackId,clip:v.clips[1],from})))
  }
  function joinSelection(){
    if(selection.length<2||new Set(selection.map(e=>e.track.id)).size>1){notify('같은 트랙에서 합칠 클립을 두 개 이상 선택해주세요.');return}
    const joined=joinClips(selection.map(e=>e.clip),project.bpm)
    if(!joined){notify('같은 오디오 파일에서 끊김 없이 이어지는 클립만 합칠 수 있습니다.');return}
    apply(mapClips(project,idsOf(selection),c=>c.id===joined.id?joined:null),'','리전 합치기');selectClips([joined.id],joined.id,selection[0].track.id)
  }
  function selectAll(){const own=focusedTrack?.clips.map(c=>c.id)??[];const ids=own.length&&!(selectedClipIds.size===own.length&&own.every(id=>selectedClipIds.has(id)))?own:[...clipIndex.keys()];if(!ids.length)return;const anchor=anchorClipId&&ids.includes(anchorClipId)?anchorClipId:ids[0];selectClips(ids,anchor,clipIndex.get(anchor)?.track.id??focusedTrackId)}
  function selectAdjacent(dir:1|-1){
    const track=anchorEntry?.track??focusedTrack;if(!track?.clips.length)return
    const sorted=[...track.clips].sort((a,b)=>a.startBeat-b.startBeat),i=anchorEntry?sorted.findIndex(c=>c.id===anchorEntry.clip.id):-1,beat=playhead()
    const next=i>=0?sorted[i+dir]:dir>0?sorted.find(c=>c.startBeat>=beat)??sorted[0]:[...sorted].reverse().find(c=>c.startBeat<beat)??sorted.at(-1)
    if(next)selectClips([next.id],next.id,track.id)
  }
  function changeLoop(start:number,end:number,enabled:boolean){const startBeat=Math.max(0,start),endBeat=Math.max(startBeat+.25,end);commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil(endBeat/p.beatsPerBar)*p.beatsPerBar),loop:{enabled,startBeat,endBeat}}))}
  function marker(action:'add'|'move'|'rename'|'delete',arg:{id?:string;beat?:number;name?:string}={}){
    if(action==='add'){const beat=arg.beat??playhead();commit(p=>addMarker(p,createMarker(beat,arg.name??`마커 ${p.markers.length+1}`)));return}
    if(!arg.id)return
    if(action==='move'&&arg.beat!==undefined)commit(p=>moveMarker(p,arg.id!,arg.beat!),`marker:${arg.id}`)
    else if(action==='rename'&&arg.name!==undefined)commit(p=>renameMarker(p,arg.id!,arg.name!))
    else if(action==='delete')commit(p=>deleteMarker(p,arg.id!))
  }
  /** Logic's Z: fit the selection; pressed again on that view (or without a selection), fit the whole project. Tracks shrink to fit vertically when they would scroll. */
  function zoomToFit(){
    const scroll=document.querySelector<HTMLElement>('.timeline-scroll');if(!scroll)return
    const fitSelection=selection.length>0&&!(lastFit.current?.kind==='selection'&&Math.abs(lastFit.current.ppb-ppb)<.01)
    const start=fitSelection?selectionStart():0,end=fitSelection?selectionEnd():Math.max(project.lengthBeats,...project.tracks.flatMap(t=>t.clips.map(c=>c.startBeat+c.lengthBeats)))
    const next=fitScale(Math.max(1,end-start),scroll.clientWidth-trackHeader.headerWidth-24,ZOOM_LIMITS.timelineX)
    const rows=Math.max(1,visibleTracks(project,hideView).length),available=scroll.clientHeight-38-(view.globalTracks?22:0)-32,rowHeight=zoom.timeline.rowHeight
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
  const clampTrackZoom=(v:number)=>Math.min(TRACK_ZOOM_LIMITS.max,Math.max(TRACK_ZOOM_LIMITS.min,v))
  function zoomTracks(ids:Iterable<string>,fn:(factor:number)=>number|null){setTrackZoom(z=>{const next={...z};for(const id of ids){const v=fn(z[id]??1);if(v===null||Math.abs(v-1)<.01)delete next[id];else next[id]=clampTrackZoom(v)}return next})}

  // Track operations
  function newTrack(opts:NewTrackOptions={}){
    if(opts.dialog){setModal('newTracks');return}
    const kind=opts.kind??(opts.sameAsFocused&&focusedTrack?focusedTrack.kind:'instrument')
    const instrument=opts.sameAsFocused&&focusedTrack?.kind==='instrument'?focusedTrack.instrument:'keys'
    const track=createTrack(kind,instrument);if(opts.empty)track.devices=[]
    const after=opts.afterId===undefined?focusedTrackId||null:opts.afterId
    commit(p=>insertTracks(p,after,[track]));focusTrack(track.id)
  }
  function createTracks(opts:NewTracksOptions){
    const tracks=Array.from({length:opts.count},()=>opts.kind==='audio'&&opts.guitarRig?createGuitarTrack():createTrack(opts.kind,opts.instrument??'keys'))
    commit(p=>insertTracks(p,focusedTrackId||null,tracks));focusTrack(tracks[0].id,tracks.map(t=>t.id));setModal(null)
    if(opts.openLibrary)patchView({libraryOpen:true})
    if(opts.kind==='audio'&&opts.guitarRig)setBottomTab('devices')
  }
  /** Settings or settings+content copies go right after the last source; record-enable and monitoring move to the new tracks (R-32). */
  function duplicateTracks(ids:string[],mode:'settings'|'content'){
    const sources=project.tracks.filter(t=>ids.includes(t.id));if(!sources.length)return
    const copies=sources.map(t=>({...(mode==='content'?duplicateTrack(t):duplicateTrackSettings(t)),armed:t.armed,monitor:t.monitor}))
    const set=new Set(sources.map(t=>t.id)),afterId=sources.at(-1)!.id
    commit(p=>insertTracks({...p,tracks:p.tracks.map(t=>set.has(t.id)&&(t.armed||t.monitor)?{...t,armed:false,monitor:false}:t)},afterId,copies))
    focusTrack(copies[0].id,copies.map(t=>t.id))
  }
  function deleteTracks(ids:string[]){
    const set=new Set(ids.filter(id=>project.tracks.some(t=>t.id===id)));if(!set.size)return
    const rows=project.tracks.map((t,i)=>set.has(t.id)?i:-1).filter(i=>i>=0),first=rows[0],last=rows.at(-1)!
    const next=project.tracks.slice(last+1).find(t=>!set.has(t.id))??project.tracks.slice(0,first).reverse().find(t=>!set.has(t.id))
    commit(p=>({...p,tracks:p.tracks.filter(t=>!set.has(t.id))}))
    if(next)focusTrack(next.id);else focusTrack('',[])
    notify(`트랙 ${set.size}개를 삭제했습니다 · 실행 취소 ${shortcutText('undo')}`)
  }
  /** Multi-track rename auto-increments like Logic: a trailing number counts up, otherwise "name 1", "name 2"… */
  function renameTracks(ids:string[],name:string|null){
    setRenamingTrackId(null);const trimmed=name?.trim();if(!trimmed)return
    const targets=project.tracks.filter(t=>ids.includes(t.id));if(!targets.length)return
    const m=targets.length>1?/^(.*?)(\d+)$/.exec(trimmed):null
    changeTracks(targets.map((t,i)=>({id:t.id,patch:{name:(targets.length===1?trimmed:m?`${m[1]}${+m[2]+i}`:`${trimmed} ${i+1}`).slice(0,512)}})),`${ids.join()}:name`)
  }
  function reorderTracks(ids:string[],afterId:string|null){
    const set=new Set(ids);if(afterId&&set.has(afterId))return
    commit(p=>{const moving=p.tracks.filter(t=>set.has(t.id));if(!moving.length)return p;const rest=p.tracks.filter(t=>!set.has(t.id));const at=afterId===null?0:rest.findIndex(t=>t.id===afterId)+1;const tracks=[...rest.slice(0,at),...moving,...rest.slice(at)];return tracks.every((t,i)=>t===p.tracks[i])?p:{...p,tracks}})
  }
  function openLibrary(id:string){trackFocus(id);patchView({libraryOpen:true})}
  function trackButton(trackId:string,kind:TrackButtonKind,mods:TrackButtonMods){const edit=(p:Project)=>pressTrackButton(p,trackId,kind,mods);if(kind==='arm'||kind==='monitor')dispatch({type:'live',edit});else commit(edit,'',TRACK_EDIT_LABELS[kind]??'트랙 버튼 변경')}
  function trackSweep(trackId:string,kind:TrackButtonKind,value:boolean){const edit=(p:Project)=>sweepTrackButton(p,trackId,kind,value);if(kind==='arm'||kind==='monitor')dispatch({type:'live',edit});else commit(edit,'',TRACK_EDIT_LABELS[kind]??'트랙 버튼 변경')}
  function clearRecall(){const r=clearRecallSolo(project,soloRecall);if(r.project!==project)commit(()=>r.project);setSoloRecall(r.recall)}
  /** Key commands toggle every selected track to the focused track's new value. */
  function toggleTracks(field:'mute'|'solo'|'armed'|'monitor'|'enabled'){if(!focusedTrack)return;const value=!focusedTrack[field];const ids=[...selectedTrackIds];changeTracks(ids.map(id=>({id,patch:{[field]:value}})),`${ids.join()}:${field}`)}
  function hideSelected(){
    const ids=[...selectedTrackIds];if(!ids.length)return
    changeTracks(ids.map(id=>({id,patch:{hidden:true}})),'hide')
    if(hideView)return
    const shown=visibleTracks(project,false).filter(t=>!selectedTrackIds.has(t.id)),i=project.tracks.findIndex(t=>t.id===focusedTrackId)
    const next=shown.find(t=>project.tracks.indexOf(t)>i)??[...shown].reverse().find(t=>project.tracks.indexOf(t)<i)
    if(next)focusTrack(next.id)
  }
  function openPalette(ids:string[],at:{x:number;y:number}){if(ids.length)setPalette({ids,...at})}
  function paletteFor(trackId:string,e:React.MouseEvent){openPalette(selectedTrackIds.has(trackId)?[...selectedTrackIds]:[trackId],anchorAt(e.currentTarget))}
  function openDevices(trackId:string,deviceId?:string){
    trackFocus(trackId);setBottomTab('devices')
    const index=project.tracks.find(t=>t.id===trackId)?.devices.findIndex(d=>d.id===deviceId)??-1
    if(index>=0)requestAnimationFrame(()=>document.querySelectorAll('.dc-effect')[index]?.scrollIntoView({block:'nearest',inline:'center'}))
  }
  function applyUi(patch:Partial<TimelineUi>){
    const {headerWidth,headerConfig:config,hideView:hide,trackZoom:tz,soloRecall:recall,renamingTrackId:renaming,recording:_r,...rest}=patch
    if(headerWidth!==undefined||config!==undefined)setTrackHeader(h=>({headerWidth:headerWidth??h.headerWidth,headerConfig:config??h.headerConfig}))
    if(hide!==undefined)setHideView(hide)
    if(tz!==undefined)setTrackZoom(tz)
    if(recall!==undefined)setSoloRecall(recall)
    if(renaming!==undefined)setRenamingTrackId(renaming)
    if(Object.keys(rest).length)patchView(rest)
  }
  function renameClip(clipId:string,name:string|null){setRenamingClipId(null);const trimmed=name?.trim();const entry=clipIndex.get(clipId);if(trimmed&&entry&&trimmed!==entry.clip.name)commit(p=>mapClips(p,new Set([clipId]),c=>({...c,name:trimmed.slice(0,512)})))}
  async function playFromSelection(){if(recordPreparingRef.current||recordRef.current)return;if(selection.length)engine.seek(selectionStart());if(!engine.getSnapshot().playing)await playTransport('start')}
  // Inside the piano roll these keys belong to note editing; the app never turns them into clip edits.
  const PIANO_OWNED=new Set<ProjectShortcut>(['copy','cut','paste','selectAll','nudgeLeft','nudgeRight','trimEndLeft','trimEndRight','transposeUp','transposeDown','transposeOctaveUp','transposeOctaveDown','deleteNotes','quantize','snapToggle'])
  function run(command:ProjectShortcut,ctx:CommandContext={}){
    if(ctx.scope==='piano'&&PIANO_OWNED.has(command)){pianoCommand.current?.(command);return}
    const step=snapStep||.25,beat=playhead(),trackIds=ctx.trackIds??[...selectedTrackIds],entries=ctx.clipIds?entriesOf(ctx.clipIds):selection
    switch(command){
      case 'playback':void playTransport();break
      case 'playFromSelection':void playFromSelection();break
      case 'undo':changeHistory('undo');break
      case 'redo':changeHistory('redo');break
      case 'save':void saveBundle();break
      case 'home':engine.seek(0);break
      case 'rewind':engine.seek(Math.max(0,(Math.ceil(beat/project.beatsPerBar-1e-6)-1)*project.beatsPerBar));break
      case 'forward':engine.seek(Math.min(project.lengthBeats,(Math.floor(beat/project.beatsPerBar+1e-6)+1)*project.beatsPerBar));break
      case 'escape':setRenamingTrackId(null);setRenamingClipId(null);setPalette(null);setHeaderConfig(null);setIconMenu(null);breakHistoryMerge();setSelectedClipIds(new Set());setAnchorClipId(null);break
      case 'help':setModal('help');break
      case 'openSettings':openAudioSettings();break
      case 'cycle':commit(p=>({...p,loop:{...p.loop,enabled:!p.loop.enabled}}));break
      case 'record':void toggleRecord();break
      case 'metronome':notify('메트로놈은 아직 오디오 엔진에 없습니다. 곧 지원됩니다.');break
      case 'snapToggle':setView(v=>({...v,snap:{...v.snap,on:!v.snap.on}}));break
      case 'zoomIn':case 'zoomOut':case 'zoomInV':case 'zoomOutV':case 'zoomToFit':zoomArea(command,ctx.scope);break
      case 'setLoopFromSelection':if(requireSelection('반복 구간으로 지정할 클립을 선택해주세요.')){const start=Math.floor(selectionStart()/project.beatsPerBar)*project.beatsPerBar;changeLoop(start,Math.max(start+project.beatsPerBar,Math.ceil(selectionEnd()/project.beatsPerBar)*project.beatsPerBar),true)}break
      case 'deleteClip':deleteClips(entries);break
      case 'split':splitSelection();break
      case 'join':joinSelection();break
      case 'repeat':duplicateSelection();break
      case 'copy':copySelection();break
      case 'cut':if(copySelection())deleteClips();break
      case 'paste':paste();break
      case 'selectAll':selectAll();break
      case 'loopClip':{const loop=entries.some(e=>!e.clip.loop);editSelection(c=>({...c,loop}),{entries,empty:'루프를 켤 클립을 선택해주세요.'});break}
      case 'muteClip':{const mute=entries.some(e=>!e.clip.mute);editSelection(c=>({...c,mute}),{entries,empty:'뮤트할 클립을 선택해주세요.'});break}
      case 'renameClip':{const target=ctx.clipIds?.[0]??anchorClipId;if(target&&clipIndex.has(target))setRenamingClipId(target);else notify('이름을 바꿀 클립을 선택해주세요.');break}
      case 'moveToPlayhead':if(requireSelection()){const d=beat-selectionStart();editSelection(c=>({...c,startBeat:Math.max(0,c.startBeat+d)}),{drag:true})}break
      case 'selectPrev':selectAdjacent(-1);break
      case 'selectNext':selectAdjacent(1);break
      case 'nudgeLeft':case 'nudgeRight':if(requireSelection()){const d=Math.max(-selectionStart(),command==='nudgeLeft'?-step:step);if(d)editSelection(c=>({...c,startBeat:c.startBeat+d}),{drag:true})}break
      case 'trimEndLeft':case 'trimEndRight':{const d=command==='trimEndLeft'?-step:step;editSelection(c=>trimClipEnd(c,c.startBeat+c.lengthBeats+d,audioMax(c)),{drag:true});break}
      case 'trimStartToPlayhead':if(requireSelection())editSelection(c=>trimClipStart(c,beat,project.bpm),{filter:e=>beat<e.clip.startBeat+e.clip.lengthBeats,empty:'재생 커서가 선택 클립의 끝보다 앞에 있어야 합니다.'});break
      case 'trimEndToPlayhead':if(requireSelection())editSelection(c=>trimClipEnd(c,beat,audioMax(c)),{filter:e=>beat>e.clip.startBeat,empty:'재생 커서가 선택 클립의 시작보다 뒤에 있어야 합니다.',drag:true});break
      case 'muteTrack':toggleTracks('mute');break
      case 'soloTrack':toggleTracks('solo');break
      case 'armTrack':toggleTracks('armed');break
      case 'monitorTrack':toggleTracks('monitor');break
      case 'toggleTrackOn':toggleTracks('enabled');break
      case 'clearRecallSolo':clearRecall();break
      case 'trackUp':moveFocus(-1,false);break
      case 'trackDown':moveFocus(1,false);break
      case 'trackUpExtend':moveFocus(-1,true);break
      case 'trackDownExtend':moveFocus(1,true);break
      case 'newTracksDialog':setModal('newTracks');break
      case 'newAudioTrack':newTrack({kind:'audio'});break
      case 'newInstrumentTrack':newTrack({kind:'instrument'});break
      case 'duplicateTrack':duplicateTracks(trackIds,'settings');break
      case 'duplicateTrackContent':duplicateTracks(trackIds,'content');break
      case 'deleteTrack':deleteTracks(trackIds);break
      case 'renameTrack':if(focusedTrack)setRenamingTrackId(focusedTrack.id);break
      case 'hideSelectedTracks':hideSelected();break
      case 'unhideAllTracks':changeTracks(project.tracks.filter(t=>t.hidden).map(t=>({id:t.id,patch:{hidden:false}})),'unhide');break
      case 'toggleHideView':setHideView(v=>!v);break
      case 'colorPalette':openPalette(trackIds,anchorAt(document.querySelector(`.track-header[data-track-id="${CSS.escape(focusedTrackId)}"]`)));break
      case 'configureTrackHeader':setHeaderConfig(anchorAt(document.querySelector('.tracks-menubar [data-menu="view"]')));break
      case 'trackZoomIn':zoomTracks(trackIds,f=>f*1.2);break
      case 'trackZoomOut':zoomTracks(trackIds,f=>f/1.2);break
      case 'trackZoomToggle':zoomTracks([focusedTrackId],f=>Math.abs(f-1)<.01?2.2:1);break
      case 'trackZoomReset':zoomTracks(trackIds,()=>null);break
      case 'zoomFocusedTrack':patchView({zoomFocused:!view.zoomFocused});break
      case 'toggleInspector':patchView({inspectorOpen:!view.inspectorOpen});break
      case 'toggleLibrary':patchView({libraryOpen:!view.libraryOpen});break
      case 'toggleBrowser':patchView({browserOpen:!view.browserOpen});break
      case 'toggleMixer':setBottomTab(t=>t==='mixer'?'editor':'mixer');break
      case 'globalTracks':patchView({globalTracks:!view.globalTracks});break
      case 'createMarker':marker('add',{beat});break
      // Timeline transposition is the non-destructive region parameter (V-12); the piano roll moves notes itself.
      case 'transposeUp':case 'transposeDown':case 'transposeOctaveUp':case 'transposeOctaveDown':{const n={transposeUp:1,transposeDown:-1,transposeOctaveUp:12,transposeOctaveDown:-12}[command];editSelection(c=>c.kind==='midi'?{...c,transpose:Math.max(-96,Math.min(96,(c.transpose??0)+n))}:c,{filter:e=>e.clip.kind==='midi',empty:'음높이를 바꿀 MIDI 클립을 선택해주세요.',key:`transpose:${[...selectedClipIds].join()}`});break}
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
        return{...p,tracks,lengthBeats:Math.ceil(end/p.beatsPerBar)*p.beatsPerBar}
      })
      const last=additions.at(-1)
      if(last){selectClips([last.clip.id],last.clip.id,last.track.id);patchView({browserOpen:true});notify(`${additions.length}개 오디오 파일을 가져왔습니다. 원본은 로컬에 보관합니다.`)}
    }catch(error){notify(`파일을 가져오지 못했습니다: ${error instanceof Error?error.message:'지원되는 오디오 파일인지 확인해주세요'}`)}finally{importing.current=false;setBusy('');if(audioInput.current)audioInput.current.value=''}
  }
  function addStoredAsset(asset:AudioAsset){const clip:AudioClip={id:uid(),kind:'audio',assetId:asset.id,name:asset.name.replace(/\.[^.]+$/,''),startBeat:Math.floor(engine.getSnapshot().beat/project.beatsPerBar)*project.beatsPerBar,lengthBeats:asset.buffer.duration*project.bpm/60,offsetSeconds:0,gain:1,fadeIn:.005,fadeOut:.01};let target=focusedTrack?.kind==='audio'?focusedTrack:createTrack('audio');target={...target,clips:[...target.clips,clip]};const targetId=target.id;commit(p=>withDragMode({...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil((clip.startBeat+clip.lengthBeats)/p.beatsPerBar)*p.beatsPerBar),tracks:p.tracks.some(t=>t.id===targetId)?p.tracks.map(t=>t.id===targetId?target:t):[...p.tracks,target]},[{trackId:targetId,clip}]));selectClips([clip.id],clip.id,targetId)}
  function prepareExport(){
    if(!loaded||navigating||busy||importing.current||exporting.current||audioApplyingRef.current){notify('프로젝트와 파일 작업이 준비된 뒤 저장해 주세요.');return null}
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
    if(pitchPending())return null
    if(recordRef.current||recordPreparingRef.current||activeControlEdits.current.size||commandSession.isGestureActive()||document.querySelector('[data-daw-gesture]')){notify('녹음·편집을 마친 뒤 파일로 저장해 주세요.');return null}
    return{project:commandSession.getSnapshot().history.present,assets:assetsRef.current}
  }
  async function saveBundle(){
    const snapshot=prepareExport();if(!snapshot)return
    exporting.current=true;setBusy('프로젝트를 묶는 중…')
    try{
      const result=await saveExport(await exportProjectBundle(snapshot.project,snapshot.assets),`${safeFilename(snapshot.project.name)}.garak`,'project')
      notify(result.status==='canceled'?'프로젝트 파일 저장을 취소했습니다.':result.status==='saved'?'프로젝트와 원본 음원을 파일로 저장했습니다.':'프로젝트와 원본 음원의 다운로드를 시작했습니다.')
    }catch(e){notify(`프로젝트 내보내기 실패: ${e instanceof Error?e.message:'파일을 저장하지 못했습니다.'}`)}finally{exporting.current=false;setBusy('')}
  }
  async function exportWav(){
    const snapshot=prepareExport();if(!snapshot)return
    exporting.current=true;setModal(null);setBusy('오디오를 렌더링하는 중…')
    try{
      const result=await saveExport(await engine.exportWav(snapshot.project),`${safeFilename(snapshot.project.name)}.wav`,'audio')
      notify(result.status==='canceled'?'WAV 파일 저장을 취소했습니다.':result.status==='saved'?'스테레오 WAV 파일을 저장했습니다.':'스테레오 WAV 파일의 다운로드를 시작했습니다.')
    }catch(e){notify(`오디오 내보내기 실패: ${e instanceof Error?e.message:'파일을 저장하지 못했습니다.'}`)}finally{exporting.current=false;setBusy('')}
  }
  /** Records onto the topmost armed audio track, else the focused audio track, else a new audio track (§2.5). */
  async function toggleRecord(){
    if(recordRef.current||recordPreparingRef.current){pausePlaybackWithRecording(engine,{cancelPreparation:cancelRecordPreparation,finishRecording});return}
    if(pitchBusyRef.current){notify('피치 분석·렌더가 끝나거나 취소된 뒤 녹음을 시작해 주세요.');return}
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){notify(desktop?'이 컴퓨터에서는 마이크 녹음을 사용할 수 없습니다.':'이 브라우저에서는 마이크 녹음을 사용할 수 없습니다.');return}
    if(busy||audioApplyingRef.current){notify('파일 처리나 오디오 설정 적용이 끝난 뒤 녹음을 시작해주세요.');return}
    const target=recordTarget(projectRef.current,focusedTrackId)
    if(target.reason==='focusedInstrument'){notify('MIDI 녹음은 아직 지원하지 않습니다');return}
    if(target.extraArmed.length)notify('한 번에 한 트랙만 녹음합니다')
    const reservedTrack=projectRef.current.tracks.find(track=>track.id===target.trackId)??{...createTrack('audio'),name:'Recording'}
    const session=projectSession.current
    const attempt=++recordAttempt.current
    const current=()=>session===projectSession.current&&attempt===recordAttempt.current
    recordPreparingRef.current=true
    setRecordPreparing(true)
    inputCapture.setNeeded('record',true)
    let pendingCapture:AudioRecording|null=null
    let startedPlayback=false
    try{
      await engine.resume();if(!current())return
      const stream=await inputCapture.acquire();if(!current())return
      // Permission may have taken time. Read the current tempo and let playback
      // normalize its start before fixing the take's position and starting capture.
      engine.setProject(projectRef.current)
      if(!engine.getSnapshot().playing){
        engine.seek(recordingStartBeat(projectRef.current,engine.getSnapshot().beat))
        startedPlayback=true
        await engine.play();if(!current())return
      }
      if(!engine.getSnapshot().playing)throw new Error('재생 시작이 취소되었습니다. 다시 녹음해 주세요.')
      const source=projectRef.current
      const track=source.tracks.find(item=>item.id===reservedTrack.id)??reservedTrack
      if(track.kind!=='audio')throw new Error('녹음 대상이 오디오 트랙이 아닙니다.')
      const name=`Recording ${new Date().toLocaleTimeString('ko-KR',{hour12:false})}`
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type))
      const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined)
      const draft:RecordingDraft={id:uid(),name,trackId:track.id,track,startBeat:engine.getSnapshot().beat,bpm:source.bpm,offsetMs:audioSettingsRef.current.recordingOffsetMs,startedAtMs:performance.now(),status:'recording'}
      const capture=new AudioRecording(recorder,{
        onError:error=>{if(current())notify(`녹음 입력 오류: ${error.message}. 수신된 오디오를 확인하고 있습니다.`)},
        onComplete:result=>{
          const active=recordRef.current
          if(!current()||active?.capture!==capture)return
          active.draft={...active.draft,status:'processing',elapsedSeconds:result.durationSeconds}
          setRecordingDraft(active.draft);setRecording(false);setBusy('녹음 파일을 처리하는 중…')
          inputCapture.setNeeded('record',false)
          if(engine.getSnapshot().playing)engine.pause()
          void(async()=>{
            try{
              if(!result.blob.size){notify('녹음 데이터가 없어 리전을 만들지 못했습니다. 입력 장치를 확인하고 다시 녹음해 주세요.');return}
              const asset=await engine.decodeAsset(result.blob,active.draft.name)
              if(!current()||recordRef.current!==active)return
              const completed=appendAudioRecording(commandSession.getSnapshot().history.present,active.draft,asset.id,asset.buffer.duration)
              if(!completed){notify('녹음 위치 보정으로 전체 녹음이 프로젝트 시작 이전에 놓였습니다. 보정값을 확인해주세요.');return}
              setAssets(previous=>{const next=new Map(previous);next.set(asset.id,asset);return next})
              commit(()=>completed.project,undefined,'오디오 녹음')
              selectClips([completed.clip.id],completed.clip.id,active.draft.trackId)
              notify(result.error?'입력 오류 전까지 수신된 녹음을 오디오 리전으로 추가했습니다.':'녹음을 오디오 리전으로 추가했습니다.')
            }catch(error){if(current())notify(`녹음 처리 실패: ${error instanceof Error?error.message:'오디오 데이터를 확인해주세요.'}`)}
            finally{
              if(recordRef.current===active){
                recordRef.current=null;active.capture.dispose()
                if(current()){setRecordingDraft(null);setRecording(false);setBusy('')}
              }
            }
          })()
        },
      })
      pendingCapture=capture
      recordRef.current={capture,stream,draft}
      capture.start()
      draft.startedAtMs=capture.startedAtMs
      setRecordingDraft(draft);setRecording(true)
      focusTrack(draft.trackId)
    }catch(e){
      pendingCapture?.dispose()
      if(!current())return
      recordRef.current=null;setRecordingDraft(null);setRecording(false);inputCapture.setNeeded('record',false)
      if(startedPlayback)engine.pause()
      notify(`녹음을 시작하지 못했습니다: ${e instanceof Error?e.message:'마이크 접근을 확인해주세요'}`)
    }finally{
      if(current()){recordPreparingRef.current=false;setRecordPreparing(false);inputCapture.setNeeded('record',recordRef.current?.draft.status==='recording')}
    }
  }
  function newProject(chooseTemplate=false){setModal(null);if(chooseTemplate)onHome();else onNew()}

  useEffect(()=>bindTransportShortcuts(window,e=>{
    const input=e.target instanceof HTMLInputElement?e.target:null
    return {
      modalOpen:navigating||!loaded||!!modal||!!document.querySelector('[aria-modal="true"],dialog[open]')||!!(e.target instanceof Element&&e.target.closest('[role="dialog"],dialog')),
      textEditing:isTransportTextTarget(e.target),
      enabled:loaded&&!busy&&!audioApplyingRef.current,
      activateToggle:input&&!input.disabled&&(input.type==='checkbox'||input.type==='radio')?()=>input.click():undefined,
    }
  },command=>run(command),transportKeyState.current))

  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      if(navigating||isShortcutSuppressed(e,true)||!loaded)return
      const waveDialog=document.querySelector('[data-wavetable-synth-dialog]')
      if(waveDialog){
        const target=e.target
        if(!(target instanceof Element)||!waveDialog.contains(target))return
        const editingText=target instanceof HTMLTextAreaElement||(target instanceof HTMLInputElement&&['text','number','search'].includes(target.type))||(target instanceof HTMLElement&&target.isContentEditable)
        const command=resolveProjectShortcut(e,'workspace',true)
        if(command==='save'||(!editingText&&(command==='undo'||command==='redo'))){
          e.preventDefault()
          if(!e.repeat&&!busy&&!document.querySelector('[data-daw-gesture]'))run(command,{scope:'workspace'})
        }
        return
      }
      if(modal){if(e.key==='Escape'&&isUnmodified(e)){e.preventDefault();if(!e.repeat&&!(modal==='settings'&&audioApplyingRef.current))setModal(null)}return}
      // The rig is a modal device editor: allow only history/save, never timeline commands.
      if(e.target instanceof Element&&e.target.closest('[data-guitar-rig-dialog]')){
        const command=resolveProjectShortcut(e,'workspace',true)
        if(command==='undo'||command==='redo'||command==='save'){
          e.preventDefault()
          if(!e.repeat&&!busy&&!commandSession.isGestureActive()&&!document.querySelector('[data-daw-gesture]'))run(command)
        }
        return
      }
      // Settings is an application command, also available from a focused input or button.
      if(resolveProjectShortcut(e,'workspace',true)==='openSettings'){e.preventDefault();if(!e.repeat)openAudioSettings();return}
      const remembered=lastShortcutEditor.current
      const visibleEditors=(['timeline','piano','mixer','devices'] as const).filter(area=>{
        const editor=document.querySelector<HTMLElement>(`[data-keyboard-scope="${area}"]`)
        if(!editor||editor.closest('[hidden]')||!editor.getClientRects().length||(area==='piano'&&!pianoCommand.current))return false
        const style=getComputedStyle(editor);return style.visibility!=='hidden'&&style.visibility!=='collapse'
      })
      const panelKind=document.querySelector<HTMLElement>('.bottom-panel')?.dataset.editorKind
      const preferred=panelKind==='mixer'?'mixer':panelKind==='devices'?'devices':panelKind==='piano'?'piano':undefined
      const resolved=resolveRoutedShortcut(e,shortcutScope(e.target),shortcutEditorScope(e.target)??remembered,true,shortcutPlatform(),{editors:visibleEditors,preferred});if(!resolved)return
      const {command,scope}=resolved
      // Consume owned repeats so a held Space cannot scroll the document and
      // a held save key cannot fall through to the browser's Save Page dialog.
      e.preventDefault()
      if(e.repeat||busy)return
      // A gesture owns editing until commit/cancel. Its Escape capture handler
      // runs before this listener; undo/save/delete cannot race its draft.
      if(commandSession.isGestureActive()||document.querySelector('[data-daw-gesture]'))return
      run(command,{scope})
    };window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)
  })

  useEffect(()=>{
    if(loaded&&!modal)return
    const dialog=document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');if(!dialog)return
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
    const focusable=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')).filter(el=>el.getClientRects().length>0)
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

  const timelineUi:TimelineUi={headerWidth:trackHeader.headerWidth,headerConfig:trackHeader.headerConfig,hideView,recording,catch:view.catch,scrollInPlay:view.scrollInPlay,snap:view.snap,dragMode:view.dragMode,globalTracks:view.globalTracks,gridLines:view.gridLines,trackZoom,zoomFocused:view.zoomFocused,soloRecall,renamingTrackId}
  const iconTrack=iconMenu?project.tracks.find(t=>t.id===iconMenu.id):undefined
  const trackProps={project,engine,recording,onTrackChange:changeTrack,onTrackButton:trackButton,onTrackSweep:trackSweep,onInstrumentChange:changeInstrument,onAddDevice:addDevice,onToggleDevice:toggleDevice,onMoveDevice:(id:string,deviceId:string,offset:number)=>editTrack(id,t=>moveDevice(t,deviceId,offset)),onRemoveDevice:(id:string,deviceId:string)=>editTrack(id,t=>({...t,devices:t.devices.filter(d=>d.id!==deviceId)})),onOpenDevices:openDevices,onMasterChange:(value:number)=>commit(p=>p.masterVolume===value?p:{...p,masterVolume:value},'master-volume','마스터 볼륨 조절'),onOpenColorPalette:paletteFor,onIconMenu:(id:string,e:React.MouseEvent)=>setIconMenu({id,...anchorAt(e.currentTarget)})}
  return <HistoryGestureContext.Provider value={commandSession}><div className="studio-app">
    <header className="app-header">
      <GiwaEave/>
      <div className="header-project">
        <button className="brand" onClick={event=>{
          // React clears currentTarget after dispatch; state updaters may run later.
          const trigger=event.currentTarget,at=anchorAt(trigger)
          setAppMenu(current=>current?null:{...at,trigger})
        }} title={`${BRAND.name} 메뉴 · 설정 ${shortcutText('openSettings')}`} aria-label={`${BRAND.name} 메뉴`} aria-haspopup="menu" aria-expanded={!!appMenu}><Brand/></button>
        <span className="header-divider"/>
        <div className="project-identity">
          <NameInput aria-label="프로젝트 이름" title={project.name} value={project.name} onCommit={name=>commit(p=>({...p,name}),'project-name','프로젝트 이름 변경')}/>
          <span className={`save-indicator ${saveStatus}`} title={saveStatus==='saved'?(desktop?'이 컴퓨터에 자동 저장됨':'이 브라우저에 자동 저장됨'):saveStatus==='error'?'저장 오류':saveStatus==='loading'?'불러오는 중':'저장 중'}><i/>{saveStatus==='saved'?'저장됨':saveStatus==='error'?'저장 실패':saveStatus==='loading'?'불러오는 중':'저장 중…'}</span>
        </div>
      </div>
      <Transport project={project} onChange={commit} onPlay={()=>void playTransport()} onStop={stop} onRecord={()=>void toggleRecord()} recording={recording} recordPreparing={recordPreparing} recordProcessing={recordingDraft?.status==='processing'} canUndo={history.past.length>0} canRedo={history.future.length>0} undoLabel={commandState.undoLabel} redoLabel={commandState.redoLabel} onUndo={()=>changeHistory('undo')} onRedo={()=>changeHistory('redo')}/>
      <div className="header-actions" role="group" aria-label="프로젝트 파일">
        <button className="header-text" onClick={()=>setModal('new')} title="새 프로젝트" aria-label="새 프로젝트"><Icon name="file-plus" size={15}/><span>새 프로젝트</span></button>
        <button className="icon-button" onClick={onHome} title="프로젝트 목록" aria-label="프로젝트 목록"><Icon name="folder"/></button>
        <button className="icon-button" onClick={()=>void saveBundle()} title="프로젝트 파일 저장 · Ctrl/⌘ S" aria-label="프로젝트 파일 저장" disabled={!!busy||pitchBusy}><Icon name="save"/></button>
        <button className="export-button" onClick={()=>setModal('export')} title="오디오 내보내기" aria-label="오디오 내보내기" disabled={!!busy||pitchBusy}><Icon name="download" size={15}/><span>내보내기</span></button>
      </div>
    </header>

    <div className="studio-body">
      {view.libraryOpen&&<Library focusedTrack={focusedTrack} engine={engine} onSelectPatch={instrument=>{if(focusedTrack?.kind==='instrument')changeInstrument(focusedTrack.id,instrument)}} onPreview={previewInstrument} onAddTrack={instrument=>{const track=createTrack('instrument',instrument);commit(p=>insertTracks(p,focusedTrackId||null,[track]));focusTrack(track.id)}}/>}
      {view.inspectorOpen&&<Inspector {...trackProps} focusedTrack={focusedTrack} selection={selection.map(e=>({trackId:e.track.id,clip:e.clip}))} arm={focusedTrack?effectiveArm(focusedTrack,focusedTrackId,project.tracks):'off'} implicitMute={!!focusedTrack&&implicitlyMuted(focusedTrack,project)} sections={view.inspectorSections} onSectionsChange={inspectorSections=>patchView({inspectorSections})} onClipsEdit={(fn,key)=>{if(selection.length)apply(mapClips(project,idsOf(selection),fn),key)}}/>}

      <main className="studio-main">
        <Timeline project={project} assets={assets} engine={engine} recordingDraft={recordingDraft} focusedTrackId={focusedTrackId} selectedTrackIds={selectedTrackIds} selectedClipIds={selectedClipIds} anchorClipId={anchorClipId} ui={timelineUi} zoom={zoom.timeline} onUiChange={applyUi} onZoomChange={patch=>patchZoom('timeline',z=>({ppb:patch.ppb===undefined?z.ppb:clampZoom(patch.ppb,ZOOM_LIMITS.timelineX),rowHeight:patch.rowHeight===undefined?z.rowHeight:clampZoom(patch.rowHeight,ZOOM_LIMITS.timelineY)}))} onTrackClick={trackClick} onTrackFocus={trackFocus} onTrackButton={trackButton} onTrackSweep={trackSweep} onTracksChange={changeTracks} onTracksReorder={reorderTracks} onNewTrack={newTrack} onDuplicateTracks={duplicateTracks} onDeleteTracks={deleteTracks} onRenameTracks={renameTracks} onOpenLibrary={openLibrary} onOpenColorPalette={openPalette} onIconMenu={(id,at)=>setIconMenu({id,...at})} onConfigureHeader={at=>setHeaderConfig(at)} onClearRecallSolo={clearRecall} onSeek={beat=>engine.seek(Math.max(0,beat))} onSeekPlay={seekPlay} onLoopChange={loop=>changeLoop(loop.startBeat,loop.endBeat,loop.enabled)} onSelectClips={selectFromMarquee} onClipMove={moveClips} onClipTrimStart={trimStart} onClipLoopToggle={(_trackId,clipId)=>apply(mapClips(project,new Set([clipId]),c=>({...c,loop:!c.loop})))} onClipLoopEnd={(_trackId,clipId,endBeat)=>commit(p=>fitProjectLength(mapClips(p,new Set([clipId]),c=>setClipLoopEnd(c,endBeat))),undefined,'리전 반복 길이')} onAddClip={addMidiClip} onAudioDrop={(files,id,beat)=>void addAudioFiles(files,id,beat)} onCommand={(command,ctx)=>run(command,ctx)} onMarker={marker} onClipOpen={(trackId,clipId)=>{selectClips([clipId],clipId,trackId);setBottomTab('editor')}} renamingClipId={renamingClipId} onClipRename={renameClip}/>
        <EditorPanel kind={bottomTab==='editor'?(selectedClip?.kind==='audio'?'audio':'piano'):bottomTab} openRequest={editorOpenRequest}><div className="editor-toolbar"><div className="editor-tabs"><button className={bottomTab==='editor'?'active':''} onClick={()=>setBottomTab('editor')}><Icon name={selectedClip?.kind==='audio'?'wave':'keys'} size={15}/>{selectedClip?.kind==='audio'?'오디오 편집':'피아노롤'}</button><button className={bottomTab==='mixer'?'active':''} onClick={()=>setBottomTab('mixer')} title={`믹서 · ${shortcutText('toggleMixer')}`}><Icon name="mixer" size={15}/>믹서</button><button className={bottomTab==='devices'?'active':''} onClick={()=>setBottomTab('devices')}><Icon name="plug" size={15}/>디바이스</button>{selectedClip?.kind==='audio'&&<button className={bottomTab==='pitch'?'active':''} onClick={()=>setBottomTab('pitch')}><Icon name="wave" size={15}/>피치 편집{pitchDirty?' •':''}</button>}</div><div className="editor-selection">{selectedClip&&<><span className="color-dot" style={{background:focusedTrack?.color}}/><span>{selectedClip.name}</span><small>{+(selectedClip.lengthBeats/project.beatsPerBar).toFixed(2)} bars{selection.length>1?` · 클립 ${selection.length}개 선택`:''}</small></>}</div><div className="editor-actions">{bottomTab==='mixer'?<ZoomControls area="믹서" onZoom={command=>zoomArea(command,'mixer')} focusTarget={()=>document.querySelector<HTMLElement>('[data-keyboard-scope="mixer"]')}/>:bottomTab==='devices'&&focusedTrack?<ZoomControls area="디바이스" axes="one" labels={{zoomOut:'축소',zoomIn:'확대',zoomToFit:'기본 크기'}} onZoom={command=>zoomArea(command,'devices')} focusTarget={()=>document.querySelector<HTMLElement>('[data-keyboard-scope="devices"]')}/>:null}<button className="icon-button small" onClick={splitSelection} disabled={!selection.length&&!focusedTrack?.clips.length} title={`재생 커서에서 클립 분할 · ${shortcutText('split')}`} aria-label="클립 분할"><Icon name="scissors" size={15}/></button><button className="icon-button small" onClick={duplicateSelection} disabled={!selection.length} title={`선택 클립 복제 · ${shortcutText('repeat')}`} aria-label="클립 복제"><Icon name="copy" size={15}/></button><button className="icon-button small" onClick={()=>{if(selection.length)deleteClips();else deleteTracks([...selectedTrackIds])}} disabled={!focusedTrack&&!selection.length} title={selection.length?`선택 클립 ${selection.length}개 삭제`:`선택 트랙 삭제 · ${shortcutText('deleteTrack')}`} aria-label={selection.length?'클립 삭제':'트랙 삭제'}><Icon name="trash" size={15}/></button><EditorPanelActions/></div></div>
          <EditorPanelBody>{bottomTab==='pitch'?selectedClip?.kind==='audio'?<Suspense fallback={<div className="editor-empty">피치 편집기를 여는 중…</div>}><PitchEditor key={`${project.id}:${selectedClip.id}`} clip={selectedClip} sourceAsset={assets.get(selectedClip.pitch?.sourceAssetId??selectedClip.assetId)} projectId={project.id} bpm={project.bpm} projectClipIds={projectClipIds} disabled={!!busy||recording||recordPreparing||audioApplying} onApply={applyPitchEdit} onReset={resetPitchEdit} onBusyChange={pitchBusyChange} onDirtyChange={pitchDirtyChange}/></Suspense>:<div className="editor-empty"><Icon name="wave" size={32}/><strong>음표 단위 피치 편집</strong><p>오디오 리전을 선택해 단선율 음원을 분석하세요.</p></div>:bottomTab==='mixer'?<Mixer {...trackProps} focusedTrackId={focusedTrackId} selectedTrackIds={selectedTrackIds} onTrackClick={trackClick} onDuplicateTracks={duplicateTracks} onDeleteTracks={deleteTracks} onColorPalette={openPalette} zoom={zoom.mixer} onZoomChange={mixer=>setZoom(z=>({...z,mixer:{channelWidth:clampZoom(mixer.channelWidth,ZOOM_LIMITS.mixerWidth),faderHeight:clampZoom(mixer.faderHeight,ZOOM_LIMITS.mixerFader)}}))} zoomRef={mixerZoom}/>:bottomTab==='devices'?focusedTrack?<DeviceChain track={focusedTrack} engine={engine} bpm={project.bpm} onSave={()=>void saveBundle()} pitchAvailable={selectedClip?.kind==='audio'} onOpenPitch={()=>setBottomTab('pitch')} scale={zoom.devices.scale} onScaleChange={scale=>patchZoom('devices',()=>({scale:clampZoom(scale,ZOOM_LIMITS.deviceScale)}))} zoomRef={deviceZoom} onInstrumentChange={instrument=>changeInstrument(focusedTrack.id,instrument)} onInstrumentParam={(key,value)=>editTrack(focusedTrack.id,t=>({...t,instrumentParams:{...t.instrumentParams,[key]:value}}),`${focusedTrack.id}:inst:${key}`)} onWavetablePatch={(patch,label,mergeKey)=>editTrack(focusedTrack.id,t=>withWavetablePatch(t,patch),mergeKey?`${focusedTrack.id}:wave:${mergeKey}`:undefined,label)} onDeviceParam={(deviceId,key,value)=>editTrack(focusedTrack.id,t=>({...t,devices:t.devices.map(d=>d.id===deviceId?{...d,params:{...d.params,[key]:value}}:d)}),`${focusedTrack.id}:dev:${deviceId}:${key}`)} onDeviceParams={(deviceId,params)=>editTrack(focusedTrack.id,t=>({...t,devices:t.devices.map(d=>d.id===deviceId?{...d,params:{...d.params,...params}}:d)}),'','기타 앰프 프리셋 변경')} onOpenAudioSettings={openAudioSettings} onAddDevice={type=>addDevice(focusedTrack.id,type)} onRemoveDevice={deviceId=>editTrack(focusedTrack.id,t=>({...t,devices:t.devices.filter(d=>d.id!==deviceId)}))} onMoveDevice={(deviceId,offset)=>editTrack(focusedTrack.id,t=>moveDevice(t,deviceId,offset))} onToggleDevice={deviceId=>toggleDevice(focusedTrack.id,deviceId)} onTrackChange={patch=>changeTrack(focusedTrack.id,patch)} onPreview={()=>previewTrack(focusedTrack)}/>:<div className="editor-empty"><Icon name="plug" size={32}/><strong>소리의 흐름을 한눈에</strong><p>트랙 헤더를 클릭하면 악기와 연결된 이펙트가 여기에 열립니다.</p></div>:selectedClip?.kind==='midi'&&focusedTrack?<PianoRollBridge beatsPerBar={project.beatsPerBar} beatUnit={quarterNotesPerBeat(project.timeSignature)} clip={selectedClip} color={focusedTrack.color} instrument={focusedTrack.instrument} zoom={zoom.piano} onZoomChange={piano=>setZoom(z=>({...z,piano}))} zoomRef={pianoZoom} commandRef={pianoCommand} onChange={clip=>changeClip(clip)} onPreview={pitch=>void engine.previewNote(focusedTrack.instrument,pitch,undefined,focusedTrack.id).catch(e=>notify(String(e)))}/>:selectedClip?.kind==='audio'?<div className="audio-editor"><div className="audio-wave-large">{assets.get(selectedClip.assetId)&&<Waveform peaks={assets.get(selectedClip.assetId)!.peaks} buffer={assets.get(selectedClip.assetId)!.buffer} offsetSeconds={selectedClip.offsetSeconds} durationSeconds={selectedClip.lengthBeats*60/project.bpm} color={focusedTrack?.color}/>}</div><div className="audio-editor-settings"><label>클립 게인<input type="range" min="0" max="2" step=".01" value={selectedClip.gain} onChange={e=>changeClip({...selectedClip,gain:+e.target.value},`${selectedClip.id}:gain`)}/><span>{db(selectedClip.gain)} dB</span></label><label>페이드 인<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeIn} onChange={e=>changeClip({...selectedClip,fadeIn:+e.target.value},`${selectedClip.id}:fadeIn`)}/><span>{selectedClip.fadeIn.toFixed(2)} s</span></label><label>페이드 아웃<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeOut} onChange={e=>changeClip({...selectedClip,fadeOut:+e.target.value},`${selectedClip.id}:fadeOut`)}/><span>{selectedClip.fadeOut.toFixed(2)} s</span></label></div></div>:<div className="editor-empty"><Icon name="keys" size={32}/><strong>아이디어를 음표로</strong><p>클립을 선택하거나 타임라인을 더블 클릭해 패턴을 만드세요.</p>{focusedTrack?.kind==='instrument'&&<button onClick={()=>addMidiClip(focusedTrack.id,0)}><Icon name="plus" size={14}/> MIDI 클립 만들기</button>}</div>}
          </EditorPanelBody>
        </EditorPanel>
      </main>

      {view.browserOpen&&<Browser assets={assets} onAddAsset={addStoredAsset} onImport={()=>{importTarget.current={};audioInput.current?.click()}}/>}
    </div>

    <footer className="status-bar"><div><button className={view.libraryOpen?'active':''} aria-pressed={view.libraryOpen} onClick={()=>patchView({libraryOpen:!view.libraryOpen})} aria-label="라이브러리 패널 전환" title={`라이브러리 · ${shortcutText('toggleLibrary')}`}><Icon name="library" size={14}/></button><button className={view.inspectorOpen?'active':''} aria-pressed={view.inspectorOpen} onClick={()=>patchView({inspectorOpen:!view.inspectorOpen})} aria-label="인스펙터 패널 전환" title={`인스펙터 · ${shortcutText('toggleInspector')}`}><Icon name="inspector" size={15}/></button><button className={view.browserOpen?'active':''} aria-pressed={view.browserOpen} onClick={()=>patchView({browserOpen:!view.browserOpen})} aria-label="브라우저 패널 전환" title={`브라우저 · ${shortcutText('toggleBrowser')}`}><Icon name="folder" size={14}/></button><span className={`status-dot ${saveStatus==='error'?'error':''}`}/><span>{saveStatus==='error'?'저장 공간을 확인해주세요':'로컬 작업 공간'}</span><span className="status-divider"/><span className="footer-caption">소리는 여기에서 시작됩니다.</span></div><div><AudioStatus onOpen={openAudioSettings}/><span className="status-divider"/><button onClick={()=>setModal('help')} title="단축키" aria-label="단축키 도움말"><Icon name="keyboard" size={15}/></button><span className="version-tag">{BRAND.version} DEV</span></div></footer>

    <input ref={audioInput} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aiff" multiple hidden onChange={e=>{if(e.target.files?.length)void addAudioFiles(e.target.files,importTarget.current.trackId,importTarget.current.beat??0)}}/>
    {appMenu&&<ContextMenu {...appMenu} label={`${BRAND.name} 메뉴`} onClose={()=>setAppMenu(null)} items={[{label:'설정…',icon:'settings',shortcut:shortcutText('openSettings'),onSelect:openAudioSettings},{label:bridgeState.status==='connected'?'AI 연결 · 연결됨':'AI 연결…',icon:'plug',onSelect:()=>setModal('mcp')},{type:'separator'},{label:'프로젝트 목록',icon:'folder',onSelect:onHome},{label:'새 프로젝트…',icon:'file-plus',onSelect:()=>setModal('new')},{label:'프로젝트 파일 가져오기…',icon:'upload',onSelect:onOpenProject},{label:'단축키 도움말',icon:'keyboard',onSelect:()=>setModal('help')},{label:`${BRAND.name} 정보`,icon:'info',onSelect:()=>setModal('about')}]}/>}
    {modal==='mcp'&&<McpConnectionDialog client={bridgeClient} instanceId={instanceId} projectName={project.name} editsAllowed={aiEditsAllowed} onEditsAllowed={value=>{aiEditsAllowedRef.current=value;setAiEditsAllowed(value)}} onClose={()=>setModal(null)}/> }
    {modal==='settings'&&<AudioSettingsDialog engine={engine} inputCapture={inputCapture} settings={audioSettings} project={project} blockedReason={recording||recordPreparing?'녹음·녹음 준비가 끝난 뒤 적용할 수 있습니다.':busy?busy:null} onApply={applyAudioSettings} onClose={()=>{if(!audioApplyingRef.current)setModal(null)}}/>}
    {palette&&<ColorPalette x={palette.x} y={palette.y} value={project.tracks.find(t=>t.id===palette.ids[0])?.color??''} onPick={hex=>changeTracks(palette.ids.map(id=>({id,patch:{color:hex}})),`${palette.ids.join()}:color`)} onClose={()=>setPalette(null)}/>}
    {headerConfig&&<HeaderConfigPopover x={headerConfig.x} y={headerConfig.y} config={trackHeader.headerConfig} onChange={headerConfig=>setTrackHeader(h=>({...h,headerConfig}))} onClose={()=>setHeaderConfig(null)}/>}
    {iconMenu&&iconTrack&&<ContextMenu x={iconMenu.x} y={iconMenu.y} label="트랙 아이콘" onClose={()=>setIconMenu(null)} items={[{label:'기본',icon:iconTrack.kind==='audio'?'wave':instrumentDef(iconTrack.instrument).icon,checked:!iconTrack.icon,onSelect:()=>editTrack(iconTrack.id,t=>{const {icon:_i,...rest}=t;return rest})},{type:'separator'},...TRACK_ICON_OPTIONS.map(([name,label])=>({label,icon:name,checked:iconTrack.icon===name,onSelect:()=>changeTrack(iconTrack.id,{icon:name})}))]}/>}
    {!loaded&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">{restoreError?<><h2 id="restore-title">저장된 작업을 확인해주세요</h2><p data-selectable-text="" tabIndex={0}>{restoreError}</p><p>자동 저장을 멈췄으며 기존 저장본은 그대로 보관됩니다. 프로젝트 목록으로 돌아가 다른 작업을 열 수 있습니다.</p><div className="modal-buttons"><button onClick={()=>window.location.reload()}>다시 시도</button><button className="primary" onClick={onHome}>프로젝트 목록</button></div></>:<><span className="spinner"/><h2 id="restore-title" style={{marginTop:20}}>작업 공간을 준비합니다</h2><p>저장된 프로젝트와 원본 음원을 불러오고 있습니다.</p></>}</section></div>}
    {notice&&<div className="toast" role="status"><Icon name="info" size={17}/><span data-selectable-text="" tabIndex={0}>{notice}</span><button onClick={()=>setNotice('')} aria-label="알림 닫기"><Icon name="close" size={15}/></button></div>}
    {busy&&<div className="busy-indicator" role="status"><span className="spinner"/>{busy}</div>}
    {modal==='newTracks'&&<NewTracksDialog focusedKind={focusedTrack?.kind} focusedInstrument={focusedTrack?.kind==='instrument'?focusedTrack.instrument:undefined} onCreate={createTracks} onClose={()=>setModal(null)}/>}
    {modal&&modal!=='newTracks'&&modal!=='settings'&&modal!=='mcp'&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className={`modal ${modal==='help'?'modal-help':''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close icon-button" onClick={()=>setModal(null)} aria-label="창 닫기"><Icon name="close"/></button>
      {modal==='new'?<><span className="modal-symbol"><Icon name="plus" size={27}/></span><h2 id="modal-title">다음 아이디어를 시작할까요?</h2><p>현재 작업을 저장한 뒤 새 프로젝트를 만듭니다. 기존 작업은 프로젝트 목록에서 다시 열 수 있습니다.</p><button className="modal-save" onClick={()=>void saveBundle()}><Icon name="save" size={16}/> {desktop?'현재 프로젝트 파일로 저장':'현재 프로젝트 내려받기'}</button><div className="modal-buttons"><button onClick={()=>newProject(true)}>샘플 프로젝트 고르기</button><button className="primary" onClick={()=>newProject()}>빈 프로젝트 만들기</button></div></>:modal==='export'?<><span className="modal-symbol"><Icon name="download" size={26}/></span><h2 id="modal-title">음악을 밖으로</h2><p>모든 트랙과 현재 믹서 설정을 하나의 스테레오 파일로 만듭니다.</p><div className="export-summary"><span>파일 이름<b>{project.name||'Untitled'}.wav</b></span><span>범위<b>{+(project.lengthBeats/project.beatsPerBar).toFixed(2)} 마디 · {(project.lengthBeats*60/project.bpm).toFixed(1)}초</b></span><span>프로젝트<b>{project.tracks.length} tracks · {project.bpm} BPM</b></span><span>형식<b>Stereo PCM 16-bit WAV · {project.sampleRate/1000} kHz</b></span></div><button className="primary modal-wide" onClick={()=>void exportWav()}><Icon name="download" size={16}/> WAV 내보내기</button><button className="text-link" onClick={()=>{setModal(null);void saveBundle()}}>편집 가능한 프로젝트(.garak)로 보관하기</button></>:modal==='help'?<><span className="modal-symbol"><Icon name="keyboard" size={27}/></span><h2 id="modal-title">손끝에서 이어지는 작업</h2><div className="shortcut-groups" data-selectable-text="" tabIndex={0}>{SCOPE_GROUPS.map(([key,title])=>{const rows=SHORTCUT_TABLE.filter(r=>r.scopes.join(',')===key&&!ZOOM_COMMANDS.includes(r.command));return rows.length?<section key={key} className="shortcut-list"><h3>{title}</h3>{rows.map(r=><div key={r.command}><span>{r.label}</span><kbd>{(shortcutPlatform()==='mac'?r.mac:r.win)||'—'}</kbd></div>)}</section>:null})}<section className="shortcut-list"><h3>확대/축소 · 키 포커스가 있는 영역에 적용</h3>{SHORTCUT_TABLE.filter(r=>ZOOM_COMMANDS.includes(r.command)).map(r=><div key={r.command}><span>{r.label}</span><kbd>{shortcutPlatform()==='mac'?r.mac:r.win}</kbd></div>)}<div><span>가로 확대/축소 (포인터 기준)</span><kbd>{shortcutPlatform()==='mac'?'⌘':'Ctrl+'}휠 · 핀치</kbd></div><div><span>세로 확대/축소 (포인터 기준)</span><kbd>{shortcutPlatform()==='mac'?'⇧⌘':'Ctrl+Shift+'}휠 / {shortcutPlatform()==='mac'?'⌥':'Alt+'}휠</kbd></div></section></div><p className="modal-note">클릭은 선택, Shift/{shortcutPlatform()==='mac'?'⌘':'Ctrl'}+클릭은 선택 추가, 빈 곳 드래그는 범위 선택입니다. 드래그 중 {shortcutPlatform()==='mac'?'⌥':'Alt'} = 복사, Ctrl = 세밀하게, Ctrl+Shift = 스냅 무시, Shift = 축 고정. 클립을 더블 클릭하면 편집기가 열립니다.</p></>:<><Brand size="large"/><h2 id="modal-title">음악을 위한 나만의 공간.</h2><p>{desktop?'React와 Web Audio로 만드는 데스크톱 DAW입니다. 프로젝트와 음원은 이 컴퓨터에 저장합니다.':'React와 Web Audio로 만드는 오픈소스 DAW입니다. 프로젝트와 음원은 브라우저에 로컬로 저장합니다.'}</p><div className="about-roadmap"><span><b>1.0</b> 웹 편집기 + 오디오 엔진 <small>개발 중</small></span><span><b>2.0</b> 로컬 호스트 + VST 연결 <small>예정</small></span></div><div className="about-meta" data-selectable-text="" tabIndex={0}>React 19.3.1 · TypeScript · 코드 GPL-3.0-only</div>
        <nav className="about-licenses" aria-label="라이선스 및 소스 코드" data-selectable-text="">
          <p>Copyright © 2026 가락이음 contributors</p>
          <p>이 프로그램은 GNU GPL v3의 조건에 따라 수정·재배포할 수 있습니다. 관련 법률이 허용하는 범위에서 보증 없이 제공됩니다.</p>
          <a href="/licenses/GPL-3.0-only.txt" target="_blank" rel="noreferrer">GNU GPL v3 전문 (GPL-3.0-only)</a>
          <a href="/licenses/garak-ieum-MIT-notice.txt" target="_blank" rel="noreferrer">이전 MIT 저작권·라이선스 고지</a>
          <a href="/licenses/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">제3자 소프트웨어·자산 고지</a>
          <a href="/licenses/SOURCE.txt" target="_blank" rel="noreferrer">이 배포본의 소스 코드 안내</a>
          <p>샘플 음원·아이콘·글꼴은 각 제공자의 라이선스를 따릅니다.</p>
        </nav><div className="about-meta" data-selectable-text="" tabIndex={0}><a href="https://lucide.dev" target="_blank" rel="noreferrer">Lucide Icons</a> · <a href="/licenses/lucide-LICENSE.txt" target="_blank" rel="noreferrer">ISC / MIT 라이선스</a></div><div className="sample-credits" data-selectable-text="" tabIndex={0}><strong>샘플 악기 출처</strong>{SAMPLE_CREDITS.map(c=><span key={c.title}>{c.url?<a href={c.url} target="_blank" rel="noreferrer">{c.title}</a>:c.title} — {c.author}, {c.license} <small>{c.instruments}</small></span>)}</div>{SOURCE_REPOSITORY_URL&&<a className="modal-save" href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer"><Icon name="external" size={16}/> GitHub 소스 코드</a>}<div className="font-credit" data-selectable-text="" tabIndex={0}>이름 글꼴: <a href={BRAND.fontSource} target="_blank" rel="noreferrer">{BRAND.fontName}</a><br/>국립한글박물관 · ㈜윤디자인그룹<br/><a href={BRAND.fontLicense} target="_blank" rel="noreferrer">공공누리 제3유형 · 글꼴 이용 조건</a></div></>}
    </section></div>}
  </div></HistoryGestureContext.Provider>
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
function AudioStatus({onOpen}:{onOpen:()=>void}){
  const audio=useSyncExternalStore(engine.subscribeAudioState,engine.getAudioState,engine.getAudioState)
  const problem=audio.status==='error'||audio.needsReconfiguration
  const label=problem?'오디오 장치 확인':audio.status==='configuring'?'오디오 설정 적용 중':audio.contextState==='running'&&audio.sampleRate?`${+(audio.sampleRate/1000).toFixed(1)} kHz · Stereo`:'오디오 설정'
  return <button className={`audio-status${problem?' error':''}`} onClick={onOpen} title={`${audio.error??'오디오 설정'} · ${shortcutText('openSettings')}`} aria-label={`${label} · 설정 열기`}><Icon name="headphones" size={13}/>{label}<Icon name="settings" size={12}/></button>
}
function Transport({project,onChange,onPlay,onStop,onRecord,recording,recordPreparing,recordProcessing,canUndo,canRedo,undoLabel,redoLabel,onUndo,onRedo}:{project:Project;onChange:(fn:(p:Project)=>Project,key?:string,label?:string)=>void;onPlay:()=>void;onStop:()=>void;onRecord:()=>void;recording:boolean;recordPreparing:boolean;recordProcessing:boolean;canUndo:boolean;canRedo:boolean;undoLabel:string|null;redoLabel:string|null;onUndo:()=>void;onRedo:()=>void}){
  const undoText=undoLabel?`실행 취소: ${undoLabel}`:'실행 취소',redoText=redoLabel?`다시 실행: ${redoLabel}`:'다시 실행'
  const snapshot=useSyncExternalStore(subscribeTransport,readTransport,readTransport)
  const notationBeat=snapshot.beat/quarterNotesPerBeat(project.timeSignature)
  const bar=Math.floor(notationBeat/project.timeSignature.numerator)+1
  const beat=Math.floor(notationBeat%project.timeSignature.numerator)+1
  const tick=Math.floor((notationBeat%1)*100)
  const seconds=snapshot.beat*60/project.bpm
  const timingDisabled=recording||recordPreparing||recordProcessing
  const loopLengths=[...new Set([...[1,2,4,8,16,32].map(bars=>bars*project.beatsPerBar),project.loop.endBeat-project.loop.startBeat])].sort((a,b)=>a-b)
  return <div className="transport-bar" role="group" aria-label="재생 및 편집">
    <div className="history-buttons">
      <button className="icon-button" onClick={onUndo} disabled={!canUndo} title={undoText} aria-label={undoText}><Icon name="undo" size={16}/></button>
      <button className="icon-button" onClick={onRedo} disabled={!canRedo} title={redoText} aria-label={redoText}><Icon name="redo" size={16}/></button>
    </div>
    <span className="transport-divider"/>
    <div className="transport-buttons">
      <button className="icon-button" onClick={()=>engine.seek(0)} title="처음으로 · Home" aria-label="처음으로"><Icon name="back" size={17}/></button>
      <button className="icon-button stop-button" onClick={onStop} title="정지" aria-label="정지"><Icon name="stop" size={15}/></button>
      <button className={`play-button ${snapshot.playing?'playing':''}`} onClick={onPlay} title="재생 / 일시 정지 · Space" aria-label={snapshot.playing?'일시 정지':'재생'}><Icon name={snapshot.playing?'pause':'play'} size={18}/></button>
      <button className={`record-button ${recording?'recording':''}`} onClick={onRecord} disabled={recordPreparing||recordProcessing} title={recordPreparing?'입력 장치를 준비하는 중…':recordProcessing?'녹음 처리 중…':recording?'녹음 종료':'마이크 녹음 시작'} aria-label={recordProcessing?'녹음 처리 중':recording?'녹음 종료':'마이크 녹음'}><i/></button>
      <button className={`icon-button loop-toggle ${project.loop.enabled?'active':''}`} onClick={()=>onChange(p=>({...p,loop:{...p.loop,enabled:!p.loop.enabled}}))} aria-label="루프 재생" aria-pressed={project.loop.enabled} title="루프 재생"><Icon name="loop" size={18}/></button>
    </div>
    <span className="transport-divider"/>
    <div className="time-display"><strong>{String(bar).padStart(3,'0')}<i>.</i>{beat}<i>.</i>{String(tick).padStart(2,'0')}</strong><span>{String(Math.floor(seconds/60)).padStart(2,'0')}:{(seconds%60).toFixed(2).padStart(5,'0')}</span></div>
    <div className="tempo-box">
      <TempoInput key={project.id} value={project.bpm} disabled={timingDisabled} onCommit={bpm=>onChange(p=>({...p,bpm}),'tempo','템포 조절')}/>
      <span>BPM</span>
    </div>
    <TimeSignatureControl value={project.timeSignature} disabled={timingDisabled} onChange={(numerator,denominator)=>onChange(p=>setProjectTimeSignature(p,numerator,denominator),undefined,'박자표 변경')}/>
    <div className="loop-length"><label>LOOP<select aria-label="루프 길이" value={project.loop.endBeat-project.loop.startBeat} onChange={e=>{const n=+e.target.value;onChange(p=>({...p,lengthBeats:Math.max(p.lengthBeats,p.loop.startBeat+n),loop:{...p.loop,endBeat:p.loop.startBeat+n}}));e.currentTarget.blur()}}>
      {loopLengths.map(n=><option key={n} value={n}>{+(n/project.beatsPerBar).toFixed(2)} bars</option>)}
    </select></label></div>
  </div>
}
