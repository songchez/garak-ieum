import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getThemeSnapshot, subscribeTheme } from '../core/theme'
import { waveformColumns, waveformNeedsSamples, type WaveformSamples } from '../core/waveform'
import { envelopeAt, fadeLengths } from '../core/clipEnvelope.js'
import type { AudioAsset, FadeCurve } from '../core/types'
import { assetPcm } from '../audio/assetPcm'

/** Region fades in seconds of the audible region (same envelope as playback, core/clipEnvelope.ts). */
export interface WaveformFades { fadeIn: number; fadeOut: number; inCurve?: FadeCurve; outCurve?: FadeCurve }

const columnsFor = (width: number) => Math.max(1, Math.floor(width / 2))

/**
 * Draws `peaks` (the overview) and, closer in, the asset's pyramid. Only a column narrower than the pyramid's
 * finest block reads samples, which are decoded on demand (src/audio/assetPcm.ts) and dropped with the component.
 */
export function Waveform({peaks, asset, sourceDuration=asset?.duration??1, offsetSeconds=0, durationSeconds=sourceDuration, color='currentColor', className='', appearanceKey='', gain=1, fades}: {peaks:number[];gain?:number;fades?:WaveformFades;asset?:AudioAsset;sourceDuration?:number;offsetSeconds?:number;durationSeconds?:number;color?:string;className?:string;appearanceKey?:string}) {
  const ref=useRef<HTMLCanvasElement>(null)
  const fadeIn=fades?.fadeIn??0,fadeOut=fades?.fadeOut??0,inCurve=fades?.inCurve,outCurve=fades?.outCurve
  const theme=useSyncExternalStore(subscribeTheme,getThemeSnapshot,getThemeSnapshot)
  const [width,setWidth]=useState(0)
  const [samples,setSamples]=useState<{asset:AudioAsset;samples:WaveformSamples}|null>(null)
  const pyramid=asset?.pyramid
  const wantSamples=!!asset&&!!pyramid&&width>0&&waveformNeedsSamples(columnsFor(width),{sourceDuration,offsetSeconds,durationSeconds},pyramid)
  useEffect(()=>{
    if(!wantSamples||!asset||samples?.asset===asset)return
    let live=true
    void assetPcm(asset).then(buffer=>{if(live)setSamples({asset,samples:{sampleRate:buffer.sampleRate,channels:Array.from({length:buffer.numberOfChannels},(_,channel)=>buffer.getChannelData(channel))}})},()=>undefined)
    return()=>{live=false}
  },[wantSamples,asset,samples])
  const detail=wantSamples&&samples?.asset===asset?samples.samples:undefined
  useEffect(()=>{if(!wantSamples&&samples)setSamples(null)},[wantSamples,samples])
  useEffect(()=>{
    const canvas=ref.current; if(!canvas)return
    const draw=()=>{
      const {width,height}=canvas.getBoundingClientRect(); const dpr=window.devicePixelRatio||1
      setWidth(width)
      canvas.width=width*dpr;canvas.height=height*dpr
      const ctx=canvas.getContext('2d');if(!ctx)return
      // Resolve currentColor and CSS variables through CSS before passing a concrete color to Canvas.
      ctx.scale(dpr,dpr);ctx.fillStyle=getComputedStyle(canvas).color
      const values=waveformColumns(peaks,columnsFor(width),{sourceDuration,offsetSeconds,durationSeconds},detail,pyramid)
      const spacing=width/values.length
      // Audible length (trimmed to the source) so the fade-out ends where playback ends.
      const audible=Math.max(0,Math.min(durationSeconds,sourceDuration-offsetSeconds))
      const [fi,fo]=fadeIn>0||fadeOut>0?fadeLengths(audible,fadeIn,fadeOut):[0,0]
      const level=(i:number)=>{if(!fi&&!fo)return gain;const t=(i+.5)*durationSeconds/values.length;return t>audible?0:gain*envelopeAt(t,audible,fi,fo,inCurve,outCurve)}
      for(let i=0;i<values.length;i++){const h=Math.max(1,Math.min(1,values[i]*level(i))*height*.9);ctx.fillRect(i*spacing,(height-h)/2,Math.max(.5,spacing-.5),h)}
    }
    const observer=new ResizeObserver(draw);observer.observe(canvas);draw();return()=>observer.disconnect()
  },[peaks,pyramid,detail,sourceDuration,offsetSeconds,durationSeconds,color,className,appearanceKey,theme,gain,fadeIn,fadeOut,inCurve,outCurve])
  return <canvas ref={ref} className={`waveform ${className}`} style={{color}} aria-hidden="true"/>
}
