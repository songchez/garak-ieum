import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { WebAudioEngine } from './audio/WebAudioEngine'
import type { AudioAsset, AudioClip, Clip, InstrumentId, MidiClip, Project, Track } from './core/types'
import { createDemoProject, createEmptyProject, createTrack, duplicateClip, splitClip, uid } from './core/project'
import { exportProjectBundle, importProjectBundle, loadProject, saveProject } from './core/storage'
import { Icon } from './components/Icon'
import { Brand } from './components/Brand'
import { BRAND, SOURCE_REPOSITORY_URL } from './brand'
import { Timeline, MiniMeter } from './components/Timeline'
import PianoRoll from './components/PianoRoll'
import Mixer from './components/Mixer'
import { Waveform } from './components/Waveform'
import { isShortcutSuppressed, isUnmodified, resolveProjectShortcut, shortcutScope } from './core/input'

// An application-session service, independent of React's render/effect lifecycle.
const engine = new WebAudioEngine()
const subscribeTransport = (cb:()=>void)=>engine.subscribe(cb)
const readTransport = ()=>engine.getSnapshot()
if(import.meta.hot)import.meta.hot.dispose(()=>engine.dispose())

const instruments:{id:InstrumentId;name:string;type:string;icon:string;color:string;description:string}[]=[
  {id:'keys',name:'Velvet Keys',type:'ELECTRIC PIANO',icon:'keys',color:'#a7cbbc',description:'부드러운 건반과 따뜻한 하모닉스'},
  {id:'bass',name:'Mono Bass',type:'ANALOG BASS',icon:'synth',color:'#b6a0e0',description:'낮게 흐르는 아날로그 베이스'},
  {id:'drums',name:'Pocket Drums',type:'DRUM MACHINE',icon:'drum',color:'#dfaa83',description:'킥 · 스네어 · 하이햇 · 퍼커션'},
  {id:'pad',name:'Cloud Pad',type:'ATMOSPHERIC',icon:'wave',color:'#8aaecb',description:'공간을 채우는 부드러운 패드'},
  {id:'pluck',name:'Glass Pluck',type:'PLUCK SYNTH',icon:'note',color:'#c9bd83',description:'반짝이는 짧은 플럭 사운드'},
]

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

export default function App(){
  const [history,dispatch]=useReducer(historyReducer,undefined,()=>({past:[],present:createDemoProject(),future:[]}))
  const project=history.present
  const [assets,setAssets]=useState<Map<string,AudioAsset>>(new Map())
  const [selectedTrackId,setSelectedTrackId]=useState(project.tracks[2]?.id??project.tracks[0]?.id??'')
  const [selectedClipId,setSelectedClipId]=useState<string|null>(project.tracks[2]?.clips[0]?.id??null)
  const [bottomTab,setBottomTab]=useState<'editor'|'mixer'>('editor')
  const [browserTab,setBrowserTab]=useState<'instruments'|'files'>('instruments')
  const [search,setSearch]=useState('')
  const [ppb,setPpb]=useState(30)
  const [snap,setSnap]=useState(.25)
  const [browserOpen,setBrowserOpen]=useState(true)
  const [inspectorOpen,setInspectorOpen]=useState(true)
  const [loaded,setLoaded]=useState(false)
  const [restoreError,setRestoreError]=useState('')
  const projectSession=useRef(0)
  const importing=useRef(false)
  const [saveStatus,setSaveStatus]=useState<'loading'|'saving'|'saved'|'error'>('loading')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState('')
  const [modal,setModal]=useState<'new'|'export'|'help'|'about'|null>(null)
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
  const selectedClip=selectedTrack?.clips.find(c=>c.id===selectedClipId)
  const selectedInstrument=instruments.find(i=>i.id===selectedTrack?.instrument)

  const notify=useCallback((message:string)=>setNotice(message),[])
  const commit=useCallback((edit:(p:Project)=>Project,key='')=>{
    const now=performance.now();const merge=!!key&&lastEdit.current.key===key&&now-lastEdit.current.time<450
    lastEdit.current={key,time:now};dispatch({type:'edit',edit,merge})
  },[])
  const breakHistoryMerge=useCallback(()=>{lastEdit.current={key:'',time:0}},[])
  const changeHistory=useCallback((type:'undo'|'redo')=>{breakHistoryMerge();dispatch({type})},[breakHistoryMerge])
  const changeTrack=useCallback((id:string,patch:Partial<Track>)=>commit(p=>({...p,tracks:p.tracks.map(t=>t.id===id?{...t,...patch}:t)}),`${id}:${Object.keys(patch).join(',')}`),[commit])
  function changeClip(clip:Clip){if(!selectedTrack)return;const id=selectedTrack.id;commit(p=>({...p,tracks:p.tracks.map(t=>t.id===id?{...t,clips:t.clips.map(c=>c.id===clip.id?clip:c)}:t)}))}
  function select(trackId:string,clipId?:string){breakHistoryMerge();setSelectedTrackId(trackId);setSelectedClipId(clipId??null);if(clipId)setBottomTab('editor')}

  useEffect(()=>{engine.setProject(project)},[project])
  useEffect(()=>{engine.setAssets(assets)},[assets])
  useEffect(()=>{
    let cancelled=false
    void(async()=>{try{const saved=await loadProject();if(cancelled)return;if(saved){const decoded=await Promise.all(saved.assets.map(a=>engine.decodeAsset(a.blob,a.name,a.id)));if(cancelled)return;const next=new Map(decoded.map(a=>[a.id,a]));engine.setAssets(next);setAssets(next);breakHistoryMerge();dispatch({type:'reset',project:saved.project});setSelectedTrackId(saved.project.tracks[0]?.id??'');setSelectedClipId(saved.project.tracks[0]?.clips[0]?.id??null)}if(!cancelled)setLoaded(true)}catch(error){if(!cancelled){setRestoreError(error instanceof Error?error.message:'저장소 오류');setSaveStatus('error')}}})()
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
    commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,beat+8),tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:[...t.clips,clip]}:t)}));select(trackId,clip.id)
  }
  function moveClip(trackId:string,clipId:string,startBeat:number,length?:number){
    commit(p=>{let end=p.lengthBeats;const tracks=p.tracks.map(t=>t.id===trackId?{...t,clips:t.clips.map(c=>{if(c.id!==clipId)return c;let lengthBeats=length??c.lengthBeats;if(c.kind==='audio'){const asset=assets.get(c.assetId);if(asset)lengthBeats=Math.min(lengthBeats,Math.max(.25,(asset.buffer.duration-c.offsetSeconds)*p.bpm/60))}end=Math.max(end,startBeat+lengthBeats);return{...c,startBeat,lengthBeats}})}:t);return{...p,tracks,lengthBeats:Math.ceil(end/4)*4}})
  }
  function duplicateSelected(){if(!selectedTrack||!selectedClip)return;const copy=duplicateClip(selectedClip,selectedClip.startBeat+selectedClip.lengthBeats);const trackId=selectedTrack.id;commit(p=>({...p,lengthBeats:Math.max(p.lengthBeats,Math.ceil((copy.startBeat+copy.lengthBeats)/4)*4),tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:[...t.clips,copy]}:t)}));select(trackId,copy.id)}
  // Track deletion is an explicit toolbar action; keyboard deletion never
  // changes scope merely because the last region or note has disappeared.
  function deleteSelected(deleteTrack=false){if(!selectedTrack)return;const trackId=selectedTrack.id;if(selectedClip){commit(p=>({...p,tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:t.clips.filter(c=>c.id!==selectedClip.id)}:t)}));setSelectedClipId(null)}else if(deleteTrack){commit(p=>({...p,tracks:p.tracks.filter(t=>t.id!==trackId)}));select(project.tracks.find(t=>t.id!==trackId)?.id??'')}}
  function splitSelected(){if(!selectedClip||!selectedTrack)return;const beat=engine.getSnapshot().beat;const parts=splitClip(selectedClip,beat,project.bpm);if(parts.length<2){notify('클립 안에 재생 커서를 놓은 다음 분할해주세요.');return}const trackId=selectedTrack.id;commit(p=>({...p,tracks:p.tracks.map(t=>t.id===trackId?{...t,clips:t.clips.flatMap(c=>c.id===selectedClip.id?parts:[c])}:t)}));select(trackId,parts[1].id)}

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
  async function saveBundle(){setBusy('프로젝트를 묶는 중…');try{downloadBlob(await exportProjectBundle(project,assets),`${safeFilename(project.name)}.noct`);notify('프로젝트와 원본 음원을 함께 내려받았습니다.')}catch(e){notify(`프로젝트 내보내기 실패: ${e instanceof Error?e.message:''}`)}finally{setBusy('')}}
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
      const command=resolveProjectShortcut(e,shortcutScope(e.target),true);if(!command)return
      // Consume owned repeats so a held Space cannot scroll the document and
      // a held save key cannot fall through to the browser's Save Page dialog.
      e.preventDefault()
      if(e.repeat||busy)return
      // A gesture owns editing until commit/cancel. Its Escape capture handler
      // runs before this listener; undo/save/delete cannot race its draft.
      if(document.querySelector('[data-daw-gesture]'))return
      switch(command){
        case 'playback':void togglePlayback();break
        case 'undo':changeHistory('undo');break
        case 'redo':changeHistory('redo');break
        case 'save':void saveBundle();break
        case 'deleteClip':deleteSelected();break
        case 'home':engine.seek(0);break
        case 'escape':setSelectedClipId(null);break
        case 'help':setModal('help');break
      }
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

  return <div className="studio-app">
    <header className="app-header">
      <button className="brand" onClick={()=>setModal('about')} title={`${BRAND.name} 정보`} aria-label={`${BRAND.name} 정보`}><Brand/></button>
      <div className="header-divider"/>
      <div className="project-identity"><input aria-label="프로젝트 이름" value={project.name} onChange={e=>commit(p=>({...p,name:e.target.value}),'project-name')}/><span className={`save-indicator ${saveStatus}`} title={saveStatus==='saved'?'이 브라우저에 자동 저장됨':saveStatus==='error'?'저장 오류':'저장 중'}><i/>{saveStatus==='saved'?'저장됨':saveStatus==='error'?'저장 실패':saveStatus==='loading'?'불러오는 중':'저장 중…'}</span></div>
      <div className="header-actions"><button className="header-text" onClick={()=>setModal('new')}>새 프로젝트</button><button className="icon-button" onClick={()=>projectInput.current?.click()} title="프로젝트 열기" aria-label="프로젝트 열기"><Icon name="folder"/></button><button className="icon-button" onClick={()=>void saveBundle()} title="프로젝트 파일 저장 · Ctrl/⌘ S" aria-label="프로젝트 파일 저장" disabled={!!busy}><Icon name="save"/></button><span className="header-divider"/><button className="export-button" onClick={()=>setModal('export')} disabled={!!busy}><Icon name="download" size={15}/><span>내보내기</span></button></div>
    </header>

    <Transport project={project} onChange={commit} onPlay={()=>void togglePlayback()} onStop={stop} onRecord={()=>void toggleRecord()} recording={recording} recordPreparing={recordPreparing} canUndo={history.past.length>0} canRedo={history.future.length>0} onUndo={()=>changeHistory('undo')} onRedo={()=>changeHistory('redo')} snap={snap} setSnap={setSnap} ppb={ppb} setPpb={setPpb}/>

    <div className={`studio-body ${!browserOpen?'browser-hidden':''} ${!inspectorOpen?'inspector-hidden':''}`}>
      {browserOpen&&<aside className="browser-panel"><div className="panel-heading"><span>브라우저</span><button className="icon-button small" onClick={()=>setBrowserOpen(false)} title="브라우저 접기" aria-label="브라우저 접기"><Icon name="panel" size={15}/></button></div><div className="browser-search"><Icon name="search" size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="소리 찾기…" aria-label="악기와 파일 검색"/><kbd>⌕</kbd></div><div className="browser-tabs"><button className={browserTab==='instruments'?'active':''} onClick={()=>setBrowserTab('instruments')}><Icon name="keys" size={14}/>악기</button><button className={browserTab==='files'?'active':''} onClick={()=>setBrowserTab('files')}><Icon name="folder" size={14}/>내 파일 <small>{assets.size||''}</small></button></div>
        <div className="browser-content">{browserTab==='instruments'?<><div className="browser-section-title"><span>기본 악기</span><span>5</span></div>{instruments.filter(i=>(i.name+i.description).toLowerCase().includes(search.toLowerCase())).map(instrument=><div className="instrument-item" key={instrument.id}><button className="instrument-preview" title={`${instrument.name} 미리 듣기`} aria-label={`${instrument.name} 미리 듣기`} onClick={()=>void engine.previewNote(instrument.id,instrument.id==='drums'?36:instrument.id==='bass'?36:60).catch(e=>notify(String(e)))} style={{color:instrument.color}}><Icon name={instrument.icon} size={22}/></button><button className="instrument-name" onClick={()=>addTrack('instrument',instrument.id)} title={instrument.description}><strong>{instrument.name}</strong><span>{instrument.type}</span></button><button className="instrument-add" title={`${instrument.name} 트랙 추가`} aria-label={`${instrument.name} 트랙 추가`} onClick={()=>addTrack('instrument',instrument.id)}><Icon name="plus" size={15}/></button></div>)}<div className="browser-tip"><span className="tip-orbit"><Icon name="bolt" size={16}/></span><strong>작은 아이디어의 시작</strong><p>악기 아이콘을 눌러 들어보세요.<br/>＋ 버튼으로 트랙에 추가합니다.</p></div></>:<><div className="browser-section-title"><span>PROJECT AUDIO</span><button onClick={()=>{recordTarget.current={};audioInput.current?.click()}} title="오디오 가져오기" aria-label="오디오 가져오기"><Icon name="plus" size={15}/></button></div>{Array.from(assets.values()).filter(a=>a.name.toLowerCase().includes(search.toLowerCase())).map(asset=><button className="audio-file-item" key={asset.id} onClick={()=>addStoredAsset(asset)} title="클릭하여 타임라인에 추가"><span><Icon name="wave" size={14}/><strong>{asset.name}</strong></span><Waveform peaks={asset.peaks}/><small>{asset.buffer.duration.toFixed(1)} s · {asset.buffer.numberOfChannels===2?'STEREO':'MONO'} <Icon name="plus" size={12}/></small></button>)}{!assets.size&&<div className="files-empty"><Icon name="wave" size={28}/><p>나만의 소리를 가져오세요</p><span>오디오 파일은 기기에 보관됩니다.</span><button onClick={()=>{recordTarget.current={};audioInput.current?.click()}}>파일 선택</button></div>}</> }</div>
        <button className="browser-import" onClick={()=>{recordTarget.current={};audioInput.current?.click()}}><Icon name="upload" size={16}/><span>오디오 가져오기</span><Icon name="plus" size={14}/></button><div className="browser-foot"><Icon name="moon" size={14}/><span>YOUR SPACE FOR SOUND.</span></div>
      </aside>}

      <main className="studio-main"><Timeline project={project} assets={assets} engine={engine} selectedTrackId={selectedTrackId} selectedClipId={selectedClipId} pixelsPerBeat={ppb} snap={snap} onSelect={select} onTrackChange={changeTrack} onClipMove={moveClip} onAddClip={addMidiClip} onAudioDrop={(files,id,beat)=>void addAudioFiles(files,id,beat)} onAddTrack={()=>addTrack()}/>
        <section className="bottom-panel"><div className="editor-toolbar"><div className="editor-tabs"><button className={bottomTab==='editor'?'active':''} onClick={()=>setBottomTab('editor')}><Icon name={selectedClip?.kind==='audio'?'wave':'keys'} size={15}/>{selectedClip?.kind==='audio'?'오디오 편집':'피아노롤'}</button><button className={bottomTab==='mixer'?'active':''} onClick={()=>setBottomTab('mixer')}><Icon name="mixer" size={15}/>믹서</button></div><div className="editor-selection">{selectedClip&&<><span className="color-dot" style={{background:selectedTrack?.color}}/><span>{selectedClip.name}</span><small>{selectedClip.lengthBeats/4} bars</small></>}</div><div className="editor-actions"><button className="icon-button small" onClick={splitSelected} disabled={!selectedClip} title="커서에서 클립 분할" aria-label="클립 분할"><Icon name="scissors" size={15}/></button><button className="icon-button small" onClick={duplicateSelected} disabled={!selectedClip} title="선택 클립 복제" aria-label="클립 복제"><Icon name="copy" size={15}/></button><button className="icon-button small" onClick={()=>deleteSelected(!selectedClip)} disabled={!selectedTrack} title={selectedClip?'클립 삭제':'선택 트랙 삭제'} aria-label={selectedClip?'클립 삭제':'트랙 삭제'}><Icon name="trash" size={15}/></button></div></div>
          {bottomTab==='mixer'?<Mixer project={project} engine={engine} selectedTrackId={selectedTrackId} onSelect={id=>select(id)} onTrackChange={changeTrack} onMasterChange={value=>commit(p=>({...p,masterVolume:value}),'master-volume')}/>:selectedClip?.kind==='midi'&&selectedTrack?<PianoRoll clip={selectedClip} color={selectedTrack.color} instrument={selectedTrack.instrument} onChange={changeClip} onPreview={pitch=>void engine.previewNote(selectedTrack.instrument,pitch).catch(e=>notify(String(e)))}/>:selectedClip?.kind==='audio'?<div className="audio-editor"><div className="audio-wave-large">{assets.get(selectedClip.assetId)&&<Waveform peaks={assets.get(selectedClip.assetId)!.peaks} color={selectedTrack?.color}/>}</div><div className="audio-editor-settings"><label>클립 게인<input type="range" min="0" max="2" step=".01" value={selectedClip.gain} onChange={e=>changeClip({...selectedClip,gain:+e.target.value})}/><span>{db(selectedClip.gain)} dB</span></label><label>페이드 인<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeIn} onChange={e=>changeClip({...selectedClip,fadeIn:+e.target.value})}/><span>{selectedClip.fadeIn.toFixed(2)} s</span></label><label>페이드 아웃<input type="range" min="0" max="2" step=".01" value={selectedClip.fadeOut} onChange={e=>changeClip({...selectedClip,fadeOut:+e.target.value})}/><span>{selectedClip.fadeOut.toFixed(2)} s</span></label></div></div>:<div className="editor-empty"><Icon name="keys" size={32}/><strong>아이디어를 음표로</strong><p>클립을 선택하거나 타임라인을 더블 클릭해 패턴을 만드세요.</p>{selectedTrack?.kind==='instrument'&&<button onClick={()=>addMidiClip(selectedTrack.id,0)}><Icon name="plus" size={14}/> MIDI 클립 만들기</button>}</div>}
        </section>
      </main>

      {inspectorOpen&&<aside className="inspector-panel"><div className="panel-heading"><span>인스펙터</span><button className="icon-button small" onClick={()=>setInspectorOpen(false)} title="인스펙터 접기" aria-label="인스펙터 접기"><Icon name="settings" size={15}/></button></div>{selectedTrack?<>
        <div className="selected-track-card"><span className="selected-instrument-icon" style={{background:selectedTrack.color+'18',color:selectedTrack.color}}><Icon name={selectedTrack.kind==='audio'?'wave':selectedInstrument?.icon??'keys'} size={26}/></span><div><span className="eyebrow">{selectedTrack.kind==='audio'?'AUDIO TRACK':'INSTRUMENT TRACK'}</span><input aria-label="트랙 이름" value={selectedTrack.name} onChange={e=>changeTrack(selectedTrack.id,{name:e.target.value})}/></div></div>
        <div className="inspector-section"><div className="section-label">TRACK <div className="track-color-options">{['#a7cbbc','#b6a0e0','#dfaa83','#8aaecb','#c9bd83','#d497ac'].map(color=><button key={color} style={{background:color}} className={selectedTrack.color===color?'chosen':''} onClick={()=>changeTrack(selectedTrack.id,{color})} aria-label={`트랙 색상 ${color}`}/>)}</div></div><div className="volume-label"><span>볼륨</span><b>{db(selectedTrack.volume)} <small>dB</small></b></div><input className="full-slider" aria-label="선택 트랙 볼륨" type="range" min="0" max="1.5" step=".01" value={selectedTrack.volume} onChange={e=>changeTrack(selectedTrack.id,{volume:+e.target.value})}/><div className="volume-label"><span>팬</span><b>{Math.abs(selectedTrack.pan)<.01?'C':`${Math.round(Math.abs(selectedTrack.pan)*100)}${selectedTrack.pan<0?' L':' R'}`}</b></div><input className="full-slider pan-slider" aria-label="선택 트랙 팬" type="range" min="-1" max="1" step=".01" value={selectedTrack.pan} onChange={e=>changeTrack(selectedTrack.id,{pan:+e.target.value})}/><div className="track-toggle-row"><button className={selectedTrack.mute?'active':''} onClick={()=>changeTrack(selectedTrack.id,{mute:!selectedTrack.mute})}>M <span>뮤트</span></button><button className={selectedTrack.solo?'active solo':''} onClick={()=>changeTrack(selectedTrack.id,{solo:!selectedTrack.solo})}>S <span>솔로</span></button></div></div>
        {selectedTrack.kind==='instrument'&&<div className="inspector-section"><div className="section-label">INSTRUMENT <span className="online-dot"/></div><div className="device-card" style={{'--device-color':selectedTrack.color} as React.CSSProperties}><div className="device-top"><Icon name={selectedInstrument?.icon??'keys'} size={18}/><span>{selectedInstrument?.name}</span></div><div className="device-art"><svg viewBox="0 0 190 46" aria-hidden="true"><path d={selectedTrack.instrument==='drums'?'M0 24h18l2-18 3 34 3-30 4 14h25l2-15 4 31 3-26 4 10h24l2-12 4 27 3-25 4 10h25l2-19 4 35 3-26 4 10h25':'M0 23C12-8 18-8 30 23s18 31 30 0 18-31 30 0 18 31 30 0 18-31 30 0 18 31 30 0 18-31 30 0'} fill="none" stroke="currentColor" strokeWidth="1.5"/></svg></div><select aria-label="악기 변경" value={selectedTrack.instrument} onChange={e=>changeTrack(selectedTrack.id,{instrument:e.target.value as InstrumentId})}>{instruments.map(i=><option value={i.id} key={i.id}>{i.name}</option>)}</select></div></div>}
        <div className="inspector-section effects-section"><div className="section-label">EFFECTS <span>3</span></div><EffectControl name="Low-pass filter" icon="settings" value={selectedTrack.effects.filter} min={100} max={20000} step={100} label={selectedTrack.effects.filter>=1000?(selectedTrack.effects.filter/1000).toFixed(1)+' kHz':selectedTrack.effects.filter+' Hz'} onChange={value=>changeTrack(selectedTrack.id,{effects:{...selectedTrack.effects,filter:value}})}/><EffectControl name="Room reverb" icon="wave" value={selectedTrack.effects.reverb} min={0} max={1} step={.01} label={Math.round(selectedTrack.effects.reverb*100)+'%'} onChange={value=>changeTrack(selectedTrack.id,{effects:{...selectedTrack.effects,reverb:value}})}/><EffectControl name="Echo delay" icon="loop" value={selectedTrack.effects.delay} min={0} max={1} step={.01} label={Math.round(selectedTrack.effects.delay*100)+'%'} onChange={value=>changeTrack(selectedTrack.id,{effects:{...selectedTrack.effects,delay:value}})}/></div>
        {selectedClip&&<div className="inspector-section clip-properties"><div className="section-label">CLIP</div><input aria-label="클립 이름" value={selectedClip.name} onChange={e=>changeClip({...selectedClip,name:e.target.value})}/><div><span>시작</span><b>{(selectedClip.startBeat/4+1).toFixed(2)} bar</b></div><div><span>길이</span><b>{(selectedClip.lengthBeats/4).toFixed(2)} bars</b></div></div>}
      </>:<div className="inspector-empty"><Icon name="settings" size={26}/><p>트랙을 선택해주세요</p></div>}<div className="master-strip"><div><Icon name="volume" size={14}/><span>MASTER OUT</span><b>{db(project.masterVolume)} dB</b></div><MiniMeter engine={engine}/><input aria-label="마스터 출력 볼륨" type="range" min="0" max="1.5" step=".01" value={project.masterVolume} onChange={e=>commit(p=>({...p,masterVolume:+e.target.value}),'master-volume')}/></div></aside>}
    </div>

    <footer className="status-bar"><div><button className={browserOpen?'active':''} onClick={()=>setBrowserOpen(!browserOpen)} aria-label="브라우저 패널 전환" title="브라우저 패널 전환"><Icon name="panel" size={14}/></button><span className={`status-dot ${saveStatus==='error'?'error':''}`}/><span>{saveStatus==='error'?'저장 공간을 확인해주세요':'로컬 작업 공간'}</span><span className="status-divider"/><span className="footer-caption">소리는 여기에서 시작됩니다.</span></div><div><AudioStatus/><span className="status-divider"/><button onClick={()=>setModal('help')} title="단축키" aria-label="단축키 도움말"><Icon name="keyboard" size={15}/></button><button className={inspectorOpen?'active':''} onClick={()=>setInspectorOpen(!inspectorOpen)} title="인스펙터 패널 전환" aria-label="인스펙터 패널 전환"><Icon name="settings" size={15}/></button><span className="version-tag">{BRAND.version} DEV</span></div></footer>

    <input ref={audioInput} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aiff" multiple hidden onChange={e=>{if(e.target.files?.length)void addAudioFiles(e.target.files,recordTarget.current.trackId,recordTarget.current.beat??0)}}/>
    <input ref={projectInput} type="file" accept=".noct,.json,application/json" hidden onChange={e=>{if(e.target.files?.[0])void openBundle(e.target.files[0])}}/>
    {!loaded&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">{restoreError?<><h2 id="restore-title">저장된 작업을 확인해주세요</h2><p>{restoreError}</p><p>기존 저장본을 보존하기 위해 자동 저장을 멈췄습니다. 새 프로젝트를 시작하면 기존 자동 저장본이 교체됩니다.</p><div className="modal-buttons"><button onClick={()=>window.location.reload()}>다시 시도</button><button className="primary" onClick={()=>{newProject();setRestoreError('');setLoaded(true)}}>새 프로젝트 시작</button></div></>:<><span className="spinner"/><h2 id="restore-title" style={{marginTop:20}}>작업 공간을 준비합니다</h2><p>저장된 프로젝트와 원본 음원을 불러오고 있습니다.</p></>}</section></div>}
    {notice&&<div className="toast" role="status"><Icon name="info" size={17}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="알림 닫기"><Icon name="close" size={15}/></button></div>}
    {busy&&<div className="busy-indicator" role="status"><span className="spinner"/>{busy}</div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close icon-button" onClick={()=>setModal(null)} aria-label="창 닫기"><Icon name="close"/></button>
      {modal==='new'?<><span className="modal-symbol"><Icon name="plus" size={27}/></span><h2 id="modal-title">다음 아이디어를 시작할까요?</h2><p>현재 프로젝트를 계속 보관하려면 먼저 프로젝트 파일을 내려받으세요. 새 프로젝트는 자동 저장된 작업을 대체합니다.</p><button className="modal-save" onClick={()=>void saveBundle()}><Icon name="save" size={16}/> 현재 프로젝트 내려받기</button><div className="modal-buttons"><button onClick={()=>newProject(true)}>데모 곡 열기</button><button className="primary" onClick={()=>newProject()}>빈 프로젝트 만들기</button></div></>:modal==='export'?<><span className="modal-symbol"><Icon name="download" size={26}/></span><h2 id="modal-title">음악을 밖으로</h2><p>모든 트랙과 현재 믹서 설정을 하나의 스테레오 파일로 만듭니다.</p><div className="export-summary"><span>파일 이름<b>{project.name||'Untitled'}.wav</b></span><span>범위<b>{project.lengthBeats/4} 마디 · {(project.lengthBeats*60/project.bpm).toFixed(1)}초</b></span><span>프로젝트<b>{project.tracks.length} tracks · {project.bpm} BPM</b></span><span>형식<b>Stereo PCM WAV</b></span></div><button className="primary modal-wide" onClick={()=>void exportWav()}><Icon name="download" size={16}/> WAV 내보내기</button><button className="text-link" onClick={()=>{setModal(null);void saveBundle()}}>편집 가능한 프로젝트(.noct)로 보관하기</button></>:modal==='help'?<><span className="modal-symbol"><Icon name="keyboard" size={27}/></span><h2 id="modal-title">손끝에서 이어지는 작업</h2><div className="shortcut-list">{[['재생 / 일시 정지','Space'],['처음으로 이동','Home'],['실행 취소','⌘ / Ctrl + Z'],['다시 실행','⌘ / Ctrl + Shift + Z'],['프로젝트 파일 저장','⌘ / Ctrl + S'],['타임라인의 선택 클립 삭제','Delete'],['피아노롤의 선택 음표 삭제','Delete'],['선택 해제','Esc']].map(([label,key])=><div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div><p className="modal-note">타임라인 더블 클릭으로 MIDI 클립을 만들고, 피아노롤에서 클릭해 음표를 추가하세요.</p></>:<><Brand size="large"/><h2 id="modal-title">음악을 위한 나만의 공간.</h2><p>React와 Web Audio로 만드는 오픈소스 DAW입니다. 프로젝트와 음원은 브라우저에 로컬로 저장합니다.</p><div className="about-roadmap"><span><b>1.0</b> 웹 편집기 + 오디오 엔진 <small>개발 중</small></span><span><b>2.0</b> 로컬 호스트 + VST 연결 <small>예정</small></span></div><div className="about-meta">React 19.3.1 · TypeScript · 코드 MIT License</div>{SOURCE_REPOSITORY_URL&&<a className="modal-save" href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer"><Icon name="external" size={16}/> GitHub 소스 코드</a>}<div className="font-credit">이름 글꼴: <a href={BRAND.fontSource} target="_blank" rel="noreferrer">{BRAND.fontName}</a><br/>국립한글박물관 · ㈜윤디자인그룹<br/><a href={BRAND.fontLicense} target="_blank" rel="noreferrer">공공누리 제3유형 · 글꼴 이용 조건</a></div></>}
    </section></div>}
  </div>
}

function EffectControl({name,icon,value,min,max,step,label,onChange}:{name:string;icon:string;value:number;min:number;max:number;step:number;label:string;onChange:(value:number)=>void}){return <div className="effect-control"><div><Icon name={icon} size={13}/><span>{name}</span><b>{label}</b></div><input aria-label={name} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(+e.target.value)}/></div>}
function AudioStatus(){const s=useSyncExternalStore(subscribeTransport,readTransport,readTransport);return <span className="audio-status"><Icon name="headphones" size={13}/>{s.ready?`${(s.sampleRate/1000).toFixed(1)} kHz · Stereo`:'오디오 준비됨'}</span>}
function Transport({project,onChange,onPlay,onStop,onRecord,recording,recordPreparing,canUndo,canRedo,onUndo,onRedo,snap,setSnap,ppb,setPpb}:{project:Project;onChange:(fn:(p:Project)=>Project,key?:string)=>void;onPlay:()=>void;onStop:()=>void;onRecord:()=>void;recording:boolean;recordPreparing:boolean;canUndo:boolean;canRedo:boolean;onUndo:()=>void;onRedo:()=>void;snap:number;setSnap:(n:number)=>void;ppb:number;setPpb:(n:number)=>void}){
  const snapshot=useSyncExternalStore(subscribeTransport,readTransport,readTransport)
  const bar=Math.floor(snapshot.beat/4)+1,beat=Math.floor(snapshot.beat%4)+1,tick=Math.floor((snapshot.beat%1)*100)
  const seconds=snapshot.beat*60/project.bpm
  return <div className="transport-bar"><div className="history-buttons"><button className="icon-button" onClick={onUndo} disabled={!canUndo} title="실행 취소" aria-label="실행 취소"><Icon name="undo" size={16}/></button><button className="icon-button" onClick={onRedo} disabled={!canRedo} title="다시 실행" aria-label="다시 실행"><Icon name="redo" size={16}/></button></div><span className="transport-divider"/><div className="transport-buttons"><button className="icon-button" onClick={()=>engine.seek(0)} title="처음으로 · Home" aria-label="처음으로"><Icon name="back" size={17}/></button><button className="icon-button stop-button" onClick={onStop} title="정지" aria-label="정지"><Icon name="stop" size={15}/></button><button className={`play-button ${snapshot.playing?'playing':''}`} onClick={onPlay} title="재생 / 일시 정지 · Space" aria-label={snapshot.playing?'일시 정지':'재생'}><Icon name={snapshot.playing?'pause':'play'} size={18}/></button><button className={`record-button ${recording?'recording':''}`} onClick={onRecord} disabled={recordPreparing} title={recording?'녹음 종료':'마이크 녹음 시작'} aria-label={recording?'녹음 종료':'마이크 녹음'}><i/></button><button className={`icon-button loop-toggle ${project.loop.enabled?'active':''}`} onClick={()=>onChange(p=>({...p,loop:{...p.loop,enabled:!p.loop.enabled}}))} aria-label="루프 재생" aria-pressed={project.loop.enabled} title="루프 재생"><Icon name="loop" size={18}/></button></div><span className="transport-divider"/><div className="time-display"><strong>{String(bar).padStart(3,'0')}<i>.</i>{beat}<i>.</i>{String(tick).padStart(2,'0')}</strong><span>{String(Math.floor(seconds/60)).padStart(2,'0')}:{(seconds%60).toFixed(2).padStart(5,'0')}</span></div><div className="tempo-box"><input type="number" min="30" max="300" value={project.bpm} disabled={recording} onChange={e=>{const bpm=+e.target.value;if(bpm>=30&&bpm<=300)onChange(p=>({...p,bpm}),'tempo')}} aria-label="템포 BPM"/><span>BPM</span></div><div className="time-signature"><strong>4 / 4</strong><span>SIGNATURE</span></div><div className="loop-length"><label>LOOP<select aria-label="루프 길이" value={project.loop.endBeat-project.loop.startBeat} onChange={e=>{const n=+e.target.value;onChange(p=>({...p,lengthBeats:Math.max(p.lengthBeats,n),loop:{...p.loop,startBeat:0,endBeat:n}}))}}>{[4,8,16,32,64,128].map(n=><option key={n} value={n}>{n/4} bars</option>)}</select></label></div><div className="transport-spacer"/><div className="snap-control"><Icon name="magnet" size={15}/><select value={snap} onChange={e=>setSnap(+e.target.value)} aria-label="스냅 간격"><option value="0">스냅 끔</option><option value="0.25">1/16</option><option value="0.5">1/8</option><option value="1">1/4</option><option value="4">1 bar</option></select></div><div className="zoom-control"><button onClick={()=>setPpb(Math.max(12,ppb-6))} aria-label="타임라인 축소" title="축소"><Icon name="minus" size={13}/></button><Icon name="search" size={13}/><button onClick={()=>setPpb(Math.min(72,ppb+6))} aria-label="타임라인 확대" title="확대"><Icon name="plus" size={13}/></button></div></div>
}
