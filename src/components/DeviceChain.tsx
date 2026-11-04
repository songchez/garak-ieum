import { Fragment, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { AudioEngine, EffectType, InstrumentId, Track } from '../core/types'
import type { AudioState } from '../core/audioSettings'
import { EFFECT_DEFS, EFFECT_TYPES, paramValue, type ParamDef } from '../core/devices'
import { instrumentDef } from '../core/instruments'
import { ZOOM_LIMITS, zoomBy, type ZoomHandle } from '../core/zoom'
import { useZoomHandle, useZoomWheel } from './useZoomWheel'
import { Icon } from './Icon'
import { Knob } from './Knob'
import { MiniMeter } from './Timeline'
import { InstrumentOptions } from './InstrumentOptions'
import { GuitarRigEditor, GuitarRigSummary } from './GuitarRig'
import './DeviceChain.css'

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
  const audioState=useSyncExternalStore(engine.subscribeAudioState??subscribeNoAudioState,engine.getAudioState??noAudioState,engine.getAudioState??noAudioState)
  const [rigEditor,setRigEditor]=useState<{trackId:string;deviceId:string}|null>(null)
  const openRig=rigEditor?.trackId===track.id?track.devices.find(device=>device.id===rigEditor.deviceId&&device.type==='guitar-rig'):undefined
  const def=instrumentDef(track.instrument)
  const defs=def.params
  const rackRef=useRef<HTMLDivElement>(null),chainRef=useRef<HTMLDivElement>(null)
  const anchor=useRef<{pos:number;px:number}|null>(null)
  function zoom(factor:number,px=0){const next=zoomBy(scale,factor,ZOOM_LIMITS.deviceScale);if(Math.abs(next-scale)<.001)return;const el=chainRef.current;if(el)anchor.current={pos:(el.scrollLeft+px)/scale,px};onScaleChange?.(next)}
  function openPlugins(){const panel=rackRef.current?.parentElement?.querySelector<HTMLElement>('.native-plugins-panel');panel?.scrollIntoView({block:'nearest'});panel?.focus({preventScroll:true})}
  function reset(){if(scale===1)return;anchor.current={pos:0,px:0};onScaleChange?.(1)}
  useZoomHandle(zoomRef,{zoom:(_axis,factor)=>zoom(factor),fit:reset})
  useZoomWheel(rackRef,{onZoomX:(factor,x)=>zoom(factor,x),onZoomY:factor=>zoom(factor)})
  useLayoutEffect(()=>{const a=anchor.current;anchor.current=null;const el=chainRef.current;if(a&&el)el.scrollLeft=Math.max(0,a.pos*scale-a.px)})
  return <div className="dc-rack" ref={rackRef} data-keyboard-scope="devices" tabIndex={-1} aria-label="디바이스 랙" style={{'--device-scale':scale} as React.CSSProperties} onPointerDown={e=>{if(e.target instanceof Element&&!e.target.closest('button,input,textarea,select,a[href],[data-selectable-text],[role="slider"]'))e.currentTarget.focus({preventScroll:true})}}><div className="device-chain" ref={chainRef} role="list" aria-label={`${track.name} 디바이스 체인`} style={{'--track-color':track.color} as React.CSSProperties}>
    {track.kind==='instrument'&&track.pluginInstrument?<section className={`dc-card dc-source ${track.pluginInstrument.enabled?'':'bypassed'}`} role="listitem" aria-label={`VST3 악기 ${track.pluginInstrument.name}`}><header className="dc-head"><span className="dc-icon"><Icon name="plug" size={14}/></span><strong>{track.pluginInstrument.name}</strong><button className="dc-preview" onClick={on.onPreview} disabled={!track.pluginInstrument.enabled} title="VST3 악기 미리 듣기"><Icon name="play" size={10}/>미리 듣기</button></header><p className="dc-note">이 트랙의 MIDI 음표를 VST3 악기로 연주합니다.</p><div className="dc-pitch-entry"><button onClick={openPlugins}>VST3 설정 열기</button></div></section>:track.kind==='instrument'?<section className="dc-card dc-source" role="listitem" aria-label={`악기 ${def.name}`}>
      <header className="dc-head"><span className="dc-icon"><Icon name={def.icon} size={14}/></span><select aria-label="악기 변경" value={track.instrument} onChange={e=>on.onInstrumentChange(e.target.value)}><InstrumentOptions/></select><button className="dc-preview" onClick={on.onPreview} title="현재 설정으로 미리 듣기"><Icon name="play" size={10}/>미리 듣기</button></header>
      <div className="dc-knobs" style={{'--cols':Math.ceil(defs.length/2)} as React.CSSProperties}>{defs.map(d=><Knob key={d.id} def={d} value={paramValue(defs,track.instrumentParams,d.id)} color={track.color} onChange={v=>on.onInstrumentParam(d.id,v)}/>)}</div>
      {def.set&&<SampleCredit engine={engine} setId={def.set}/>}
    </section>:<section className="dc-card dc-source" role="listitem" aria-label="오디오 입력">
      <header className="dc-head"><span className="dc-icon"><Icon name="wave" size={14}/></span><strong>오디오 입력</strong></header>
      <p className="dc-note">이 트랙의 오디오 클립 신호가 오른쪽 디바이스를 차례로 지나 출력으로 갑니다.</p>
      {on.onOpenPitch&&<div className="dc-pitch-entry"><button onClick={on.onOpenPitch} disabled={!on.pitchAvailable} title={on.pitchAvailable?'선택 리전의 음표 피치 편집기 열기':'이 트랙의 오디오 리전을 선택해 주세요'}><Icon name="note" size={13}/><span>피치 편집 열기</span><Icon name="right" size={11}/></button><small>{on.pitchAvailable?'원본 보존 · 음표 단위 편집':'오디오 리전을 선택하세요'}</small></div>}
    </section>}
    {track.devices.map((device,index)=>{const d=EFFECT_DEFS[device.type];return <Fragment key={device.id}><Wire/>
      <section className={`dc-card dc-effect ${device.enabled?'':'bypassed'}`} role="listitem" aria-label={`${index+1}번 ${d.name}${device.enabled?'':' (바이패스)'}`}>
        <header className="dc-head"><button className={`dc-power ${device.enabled?'on':''}`} aria-pressed={device.enabled} aria-label={`${d.name} 켜기/끄기`} title="켜기/끄기 (바이패스)" onClick={()=>on.onToggleDevice(device.id)}><Icon name="power" size={11}/></button><span className="dc-icon"><Icon name={device.type} size={14}/></span><strong title={d.name}>{d.name}</strong><span className="dc-tools"><button onClick={()=>on.onMoveDevice(device.id,-1)} disabled={index===0} title="왼쪽으로 이동" aria-label={`${d.name} 왼쪽으로 이동`}><Icon name="left" size={11}/></button><button onClick={()=>on.onMoveDevice(device.id,1)} disabled={index===track.devices.length-1} title="오른쪽으로 이동" aria-label={`${d.name} 오른쪽으로 이동`}><Icon name="right" size={11}/></button><button onClick={()=>on.onRemoveDevice(device.id)} title="디바이스 삭제" aria-label={`${d.name} 삭제`}><Icon name="close" size={11}/></button></span></header>
        {device.type==='guitar-rig'?<GuitarRigSummary device={device} onOpen={()=>setRigEditor({trackId:track.id,deviceId:device.id})}/>:<div className="dc-knobs" style={{'--cols':Math.ceil(d.params.length/2)} as React.CSSProperties}>{d.params.map(p=><Knob key={p.id} def={p} value={paramValue(d.params,device.params,p.id)} onChange={v=>on.onDeviceParam(device.id,p.id,v)}/>)}</div>}
      </section></Fragment>})}
    <Wire/>
    <section className="dc-card dc-add" role="listitem" aria-label="디바이스 추가">
      <header className="dc-head"><span className="dc-icon"><Icon name="plug" size={13}/></span><strong>디바이스 추가</strong></header>
      <div className="dc-add-list">{EFFECT_TYPES.map(type=><button key={type} onClick={()=>on.onAddDevice(type)} title={`${EFFECT_DEFS[type].name}를 체인 끝에 추가`}><Icon name={type} size={12}/>{EFFECT_DEFS[type].short}</button>)}</div>
    </section>
    <Wire/>
    {!!track.pluginInserts?.length&&<><section className="dc-card dc-effect" role="listitem" aria-label="VST3 인서트"><header className="dc-head"><span className="dc-icon"><Icon name="plug" size={14}/></span><strong>VST3 인서트</strong></header><p className="dc-note">{track.pluginInserts.map((plugin,index)=><Fragment key={plugin.id}>{index+1}. {plugin.name}{plugin.enabled?'':' · 바이패스'}<br/></Fragment>)}</p><div className="dc-pitch-entry"><button onClick={openPlugins}>VST3 체인 편집</button></div></section><Wire/></>}
    <section className="dc-card dc-output" role="listitem" aria-label="출력">
      <header className="dc-head"><span className="dc-icon"><Icon name="volume" size={13}/></span><strong>출력</strong></header>
      <div className="dc-output-body"><div className="dc-output-knobs"><Knob def={VOLUME} value={track.volume} color={track.color} onChange={volume=>on.onTrackChange({volume})}/><Knob def={PAN} value={track.pan} color={track.color} onChange={pan=>on.onTrackChange({pan})}/></div><MiniMeter engine={engine} trackId={track.id} vertical color={track.color}/></div>
    </section>
  </div>{openRig&&<GuitarRigEditor key={openRig.id} device={openRig} track={track} audioState={audioState} onParam={(key,value)=>on.onDeviceParam(openRig.id,key,value)} onParams={params=>on.onDeviceParams(openRig.id,params)} onToggle={()=>on.onToggleDevice(openRig.id)} onTrackChange={on.onTrackChange} onOpenAudioSettings={on.onOpenAudioSettings} onClose={()=>setRigEditor(null)}/>}</div>
}
