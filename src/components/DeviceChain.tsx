import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { AudioEngine, EffectDevice, EffectType, InstrumentId, PluginDevice, Track } from '../core/types'
import type { NativePluginDescriptor, NativePluginInstance } from '../audio/native/contracts'
import type { AudioState } from '../core/audioSettings'
import { EFFECT_DEFS, EFFECT_TYPES, paramValue, type ParamDef } from '../core/devices'
import { instrumentDef } from '../core/instruments'
import { ZOOM_LIMITS, zoomBy, type ZoomHandle } from '../core/zoom'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
import { Icon } from './Icon'
import { Knob } from './Knob'
import { MiniMeter } from './Timeline'
import { InstrumentOptions } from './InstrumentOptions'
import { combineWavetablePatch, type WavetablePatch } from '../devices/wavetable-synth/model'
import { WAVETABLE_HOST_REQUIRED } from '../audio/instrumentSupport'
import { useInstrumentAvailability } from './useInstrumentAvailability'
import { GuitarRigEditor, GuitarRigSummary } from './GuitarRig'
import { PluginControls, type PluginEngine } from './PluginControls'
import { pluginKey, usePluginCatalog } from './usePluginCatalog'
import './DeviceChain.css'

const WavetableSynth = lazy(() => import('../devices/wavetable-synth/WavetableSynth').then(module => ({ default: module.WavetableSynth })))

const VOLUME:ParamDef={id:'volume',label:'볼륨',min:0,max:1.5,default:.7,unit:'gain'}
const PAN:ParamDef={id:'pan',label:'팬',min:-1,max:1,default:0,unit:'pan'}
const subscribeNoAudioState=()=>()=>{}
const noAudioState=()=>null
type DeviceAudioEngine=AudioEngine&{
  getAudioState?:()=>AudioState
  subscribeAudioState?:(callback:()=>void)=>()=>void
}

interface Props {
  track:Track; engine:DeviceAudioEngine
  onInstrumentChange:(instrument:InstrumentId)=>void
  onInstrumentParam:(key:string,value:number)=>void
  onWavetablePatch:(patch:WavetablePatch,label:string,mergeKey?:string)=>void
  onSave?:()=>void
  bpm?:number
  onDeviceParam:(deviceId:string,key:string,value:number)=>void
  onDeviceParams:(deviceId:string,params:Record<string,number>)=>void
  onOpenAudioSettings?:()=>void
  onAddDevice:(type:EffectType)=>void
  onRemoveDevice:(deviceId:string)=>void
  onMoveDevice:(deviceId:string,offset:number)=>void
  onToggleDevice:(deviceId:string)=>void
  onTrackChange:(patch:Partial<Track>)=>void
  onPreview:()=>void
  onOpenPitch?:()=>void
  pitchAvailable?:boolean
  /** Card scale (0.75–1.5); the rack zooms as a whole, so it is one axis. */
  scale?:number
  onScaleChange?:(scale:number)=>void
  zoomRef?:RefObject<ZoomHandle|null>
  /** VST3 effects join the chain as devices; a VST3 instrument becomes the track's source. Desktop engine only. */
  onAddPlugin?:(plugin:NativePluginDescriptor)=>void
  onPluginChange?:(instanceId:string,update:(plugin:NativePluginInstance)=>NativePluginInstance,label:string)=>void
  onOpenPluginSettings?:()=>void
  /** Recording, rendering or audio reconfiguration: VST3 windows and state capture wait. */
  pluginsLocked?:boolean
}
const Wire=()=><span className="dc-wire" aria-hidden="true"><i/><Icon name="right" size={10}/></span>

function SampleCredit({engine,setId}:{engine:AudioEngine;setId:string}){
  const status=useSyncExternalStore(engine.subscribeSamples,()=>engine.sampleStatus(setId),()=>'idle' as const)
  const credit=engine.sampleAttribution(setId)
  if(status==='error')return <p className="dc-credit error" data-selectable-text="" tabIndex={0}>샘플을 불러오지 못했습니다</p>
  if(status==='loading')return <p className="dc-credit">샘플을 불러오는 중…</p>
  if(!credit)return null
  return <p className="dc-credit" data-selectable-text="" tabIndex={0} title={`${credit.title} — ${credit.author}, ${credit.license}`}>{credit.title} — {credit.author}, {credit.license}</p>
}

export function DeviceChain({track,engine,scale=1,onScaleChange,zoomRef,...on}:Props){
  const canPlay=useInstrumentAvailability(engine)
  const catalog=usePluginCatalog(engine as Parameters<typeof usePluginCatalog>[0])
  const pluginEngine=catalog.supported?engine as unknown as PluginEngine:null
  const pluginInstruments=catalog.plugins.filter(plugin=>plugin.isInstrument)
  const pluginEffects=catalog.plugins.filter(plugin=>!plugin.isInstrument)
  const pluginBody=<T extends NativePluginInstance>(plugin:T)=>pluginEngine&&<PluginControls engine={pluginEngine} plugin={plugin} trackEnabled={track.enabled} locked={!!on.pluginsLocked} catalog={catalog.plugins} catalogLoaded={catalog.loaded}
    onChange={(update,label)=>on.onPluginChange?.(plugin.id,current=>update(current as T),label)} onOpenPluginSettings={on.onOpenPluginSettings}/>
  // One source picker: builtin instruments and registered VST3 instruments are both "instruments".
  const sourceValue=track.pluginInstrument?`vst3:${pluginKey(track.pluginInstrument)}`:track.instrument
  function chooseSource(value:string){
    if(!value.startsWith('vst3:')){on.onInstrumentChange(value);return}
    const plugin=pluginInstruments.find(item=>`vst3:${pluginKey(item)}`===value)
    if(plugin&&value!==sourceValue)on.onAddPlugin?.(plugin)
  }
  const sourceSelect=<select aria-label="악기 변경" value={sourceValue} onChange={e=>chooseSource(e.target.value)}><InstrumentOptions/>
    {(pluginInstruments.length>0||track.pluginInstrument)&&<optgroup label="VST3 악기">
      {track.pluginInstrument&&!pluginInstruments.some(item=>`vst3:${pluginKey(item)}`===sourceValue)&&<option value={sourceValue}>{track.pluginInstrument.name}</option>}
      {pluginInstruments.map(plugin=><option key={pluginKey(plugin)} value={`vst3:${pluginKey(plugin)}`}>{plugin.name}{plugin.vendor?` · ${plugin.vendor}`:''}</option>)}
    </optgroup>}
  </select>
  const audioState=useSyncExternalStore(engine.subscribeAudioState??subscribeNoAudioState,engine.getAudioState??noAudioState,engine.getAudioState??noAudioState)
  const [rigEditor,setRigEditor]=useState<{trackId:string;deviceId:string}|null>(null)
  const openRig=rigEditor?.trackId===track.id?track.devices.find(device=>device.id===rigEditor.deviceId&&device.type==='guitar-rig'):undefined
  const rig=openRig&&openRig.type!=='vst3'?openRig:undefined
  const def=instrumentDef(track.instrument)
  const defs=def.params
  const [waveEditorTrackId,setWaveEditorTrackId]=useState<string|null>(null)
  useEffect(()=>setWaveEditorTrackId(null),[track.id,track.instrument,track.pluginInstrument?.id])
  const wavePatch=useMemo(()=>track.kind==='instrument'&&!track.pluginInstrument&&track.instrument==='wavetable'?combineWavetablePatch(track.instrumentParams,track.instrumentState):null,[track.kind,track.pluginInstrument,track.instrument,track.instrumentParams,track.instrumentState])
  const cardDefs=wavePatch?defs.filter(param=>/^macro[1-4]$/.test(param.id)):defs
  const rackRef=useRef<HTMLDivElement>(null),chainRef=useRef<HTMLDivElement>(null)
  const anchor=useRef<{pos:number;px:number}|null>(null)
  function zoom(factor:number,px=0){const next=zoomBy(scale,factor,ZOOM_LIMITS.deviceScale);if(Math.abs(next-scale)<.001)return;const el=chainRef.current;if(el)anchor.current={pos:(el.scrollLeft+px)/scale,px};onScaleChange?.(next)}
  function reset(){if(scale===1)return;anchor.current={pos:0,px:0};onScaleChange?.(1)}
  useZoomHandle(zoomRef,{zoom:(_axis,factor)=>zoom(factor),fit:reset})
  useZoomWheel(rackRef,{onZoomX:(factor,x)=>zoom(factor,x),onZoomY:factor=>zoom(factor)})
  useLayoutEffect(()=>{const a=anchor.current;anchor.current=null;const el=chainRef.current;if(a&&el)el.scrollLeft=Math.max(0,a.pos*scale-a.px)})
  return <div className="dc-rack" ref={rackRef} data-keyboard-scope="devices" tabIndex={-1} aria-label="디바이스 랙" style={{'--device-scale':scale} as React.CSSProperties} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href],[data-selectable-text],[role="slider"]'))e.currentTarget.focus({preventScroll:true})}}><div className="device-chain" ref={chainRef} role="list" aria-label={`${track.name} 디바이스 체인`} style={{'--track-color':track.color} as React.CSSProperties}>
    {track.kind==='instrument'&&track.pluginInstrument?<section className={`dc-card dc-source dc-plugin ${track.pluginInstrument.enabled?'':'bypassed'}`} role="listitem" aria-label={`VST3 악기 ${track.pluginInstrument.name}`}><header className="dc-head"><button className={`dc-power ${track.pluginInstrument.enabled?'on':''}`} aria-pressed={track.pluginInstrument.enabled} aria-label={`${track.pluginInstrument.name} 켜기/끄기`} title="켜기/끄기" onClick={()=>on.onPluginChange?.(track.pluginInstrument!.id,plugin=>({...plugin,enabled:!plugin.enabled}),'VST3 켬/끔')}><Icon name="power" size={11}/></button>{sourceSelect}<button className="dc-preview" onClick={on.onPreview} disabled={!track.pluginInstrument.enabled} title="VST3 악기 미리 듣기"><Icon name="play" size={10}/>미리 듣기</button></header><p className="dc-note"><span className="dc-format">VST3</span> 이 트랙의 MIDI 음표를 연주합니다.</p>{pluginBody(track.pluginInstrument)}</section>:track.kind==='instrument'?<section className="dc-card dc-source" role="listitem" aria-label={`악기 ${def.name}`}>
      <header className="dc-head"><span className="dc-icon"><Icon name={def.icon} size={14}/></span>{sourceSelect}<button className="dc-preview" onClick={on.onPreview} disabled={!canPlay(track.instrument)} title={canPlay(track.instrument)?'현재 설정으로 미리 듣기':WAVETABLE_HOST_REQUIRED}><Icon name="play" size={10}/>미리 듣기</button></header>
      <div className="dc-knobs" style={{'--cols':Math.ceil(cardDefs.length/2)} as React.CSSProperties}>{cardDefs.map(d=><Knob key={d.id} def={d} value={paramValue(defs,track.instrumentParams,d.id)} color={track.color} onChange={v=>on.onInstrumentParam(d.id,v)}/>)}</div>
      {wavePatch&&<div className="dc-wave-entry"><span>{wavePatch.metadata.name}</span><button onClick={()=>setWaveEditorTrackId(track.id)} aria-label="IEUM WAVE 편집기 열기"><Icon name="synth" size={14}/> IEUM WAVE 열기 <Icon name="right" size={12}/></button><small>{canPlay(track.instrument)?'네이티브 음원 연결됨':'음색 편집 · 저장 가능 / 엔진 연결 대기'}</small></div>}
      {def.set&&<SampleCredit engine={engine} setId={def.set}/>}
    </section>:<section className="dc-card dc-source" role="listitem" aria-label="오디오 입력">
      <header className="dc-head"><span className="dc-icon"><Icon name="wave" size={14}/></span><strong>오디오 입력</strong></header>
      <p className="dc-note">이 트랙의 오디오 클립 신호가 오른쪽 디바이스를 차례로 지나 출력으로 갑니다.</p>
      {on.onOpenPitch&&<div className="dc-pitch-entry"><button onClick={on.onOpenPitch} disabled={!on.pitchAvailable} title={on.pitchAvailable?'선택 리전의 음표 피치 편집기 열기':'이 트랙의 오디오 리전을 선택해 주세요'}><Icon name="note" size={13}/><span>피치 편집 열기</span><Icon name="right" size={11}/></button><small>{on.pitchAvailable?'원본 보존 · 음표 단위 편집':'오디오 리전을 선택하세요'}</small></div>}
    </section>}
    {track.devices.map((device,index)=>{const plugin=device.type==='vst3'?device:null,d=plugin?null:EFFECT_DEFS[device.type as EffectType],name=plugin?plugin.name:d!.name;return <Fragment key={device.id}><Wire/>
      <section className={`dc-card dc-effect${plugin?' dc-plugin':''} ${device.enabled?'':'bypassed'}`} role="listitem" aria-label={`${index+1}번 ${name}${plugin?' (VST3)':''}${device.enabled?'':' (바이패스)'}`}>
        <header className="dc-head"><button className={`dc-power ${device.enabled?'on':''}`} aria-pressed={device.enabled} aria-label={`${name} 켜기/끄기`} title="켜기/끄기 (바이패스)" onClick={()=>on.onToggleDevice(device.id)}><Icon name="power" size={11}/></button><span className="dc-icon"><Icon name={plugin?'plug':device.type} size={14}/></span><strong title={name}>{name}</strong>{plugin&&<span className="dc-format">VST3</span>}<span className="dc-tools"><button onClick={()=>on.onMoveDevice(device.id,-1)} disabled={index===0} title="왼쪽으로 이동" aria-label={`${name} 왼쪽으로 이동`}><Icon name="left" size={11}/></button><button onClick={()=>on.onMoveDevice(device.id,1)} disabled={index===track.devices.length-1} title="오른쪽으로 이동" aria-label={`${name} 오른쪽으로 이동`}><Icon name="right" size={11}/></button><button onClick={()=>{if(plugin)void pluginEngine?.pluginEditor(plugin.id,false).catch(()=>undefined);on.onRemoveDevice(device.id)}} title="디바이스 삭제" aria-label={`${name} 삭제`}><Icon name="close" size={11}/></button></span></header>
        {plugin?pluginBody(plugin as PluginDevice):device.type==='guitar-rig'?<GuitarRigSummary device={device} onOpen={()=>setRigEditor({trackId:track.id,deviceId:device.id})}/>:<div className="dc-knobs" style={{'--cols':Math.ceil(d!.params.length/2)} as React.CSSProperties}>{d!.params.map(p=><Knob key={p.id} def={p} value={paramValue(d!.params,(device as EffectDevice).params,p.id)} onChange={v=>on.onDeviceParam(device.id,p.id,v)}/>)}</div>}
      </section></Fragment>})}
    <Wire/>
    <section className="dc-card dc-add" role="listitem" aria-label="디바이스 추가">
      <header className="dc-head"><span className="dc-icon"><Icon name="plug" size={13}/></span><strong>디바이스 추가</strong></header>
      <div className="dc-add-list">{EFFECT_TYPES.map(type=><button key={type} onClick={()=>on.onAddDevice(type)} title={`${EFFECT_DEFS[type].name}를 체인 끝에 추가`}><Icon name={type} size={12}/>{EFFECT_DEFS[type].short}</button>)}</div>
      {catalog.supported&&<div className="dc-add-plugins" role="group" aria-label="VST3 이펙트 추가"><small>VST3</small>
        {pluginEffects.map(plugin=><button key={pluginKey(plugin)} disabled={on.pluginsLocked} onClick={()=>on.onAddPlugin?.(plugin)} title={`${plugin.name}${plugin.vendor?` · ${plugin.vendor}`:''}를 체인 끝에 추가`}><Icon name="plug" size={12}/>{plugin.name}</button>)}
        {on.onOpenPluginSettings&&<button className="dc-add-register" onClick={on.onOpenPluginSettings} title="설정 › 플러그인에서 VST3 파일을 등록합니다"><Icon name="plus" size={12}/>{pluginEffects.length?'플러그인 관리…':'VST3 등록…'}</button>}
      </div>}
    </section>
    <Wire/>
    <section className="dc-card dc-output" role="listitem" aria-label="출력">
      <header className="dc-head"><span className="dc-icon"><Icon name="volume" size={13}/></span><strong>출력</strong></header>
      <div className="dc-output-body"><div className="dc-output-knobs"><Knob def={VOLUME} value={track.volume} color={track.color} onChange={volume=>on.onTrackChange({volume})}/><Knob def={PAN} value={track.pan} color={track.color} onChange={pan=>on.onTrackChange({pan})}/></div><MiniMeter engine={engine} trackId={track.id} vertical color={track.color}/></div>
    </section>
  </div>{waveEditorTrackId===track.id&&wavePatch&&<Suspense fallback={<div className="dc-wave-loading" role="status">IEUM WAVE를 여는 중…</div>}><WavetableSynth key={track.id} trackId={track.id} trackName={track.name} patch={wavePatch} onPatchChange={on.onWavetablePatch} onClose={()=>setWaveEditorTrackId(null)} nativeBridge={engine.kind==='native'?engine.wavetable:undefined} onSave={on.onSave} bpm={on.bpm}/></Suspense>}
  {rig&&<GuitarRigEditor key={rig.id} device={rig} track={track} audioState={audioState} onParam={(key,value)=>on.onDeviceParam(rig.id,key,value)} onParams={params=>on.onDeviceParams(rig.id,params)} onToggle={()=>on.onToggleDevice(rig.id)} onTrackChange={on.onTrackChange} onOpenAudioSettings={on.onOpenAudioSettings} onClose={()=>setRigEditor(null)}/>}</div>
}
