import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getThemeSnapshot, subscribeTheme } from '../core/theme'
import { waveformColumns } from '../core/waveform'
import { envelopeAt, fadeLengths } from '../core/clipEnvelope.js'
import type { FadeCurve } from '../core/types'

/** Region fades in seconds of the audible region (same envelope as playback, core/clipEnvelope.ts). */
export interface WaveformFades { fadeIn: number; fadeOut: number; inCurve?: FadeCurve; outCurve?: FadeCurve }
export function Waveform({peaks, buffer, sourceDuration=buffer?.duration??1, offsetSeconds=0, durationSeconds=sourceDuration, color='currentColor', className='', appearanceKey='', gain=1, fades}: {peaks:number[];gain?:number;fades?:WaveformFades;buffer?:AudioBuffer;sourceDuration?:number;offsetSeconds?:number;durationSeconds?:number;color?:string;className?:string;appearanceKey?:string}) {
  const ref=useRef<HTMLCanvasElement>(null)
  const fadeIn=fades?.fadeIn??0,fadeOut=fades?.fadeOut??0,inCurve=fades?.inCurve,outCurve=fades?.outCurve
  const theme=useSyncExternalStore(subscribeTheme,getThemeSnapshot,getThemeSnapshot)
  useEffect(()=>{
    const canvas=ref.current; if(!canvas)return
    const draw=()=>{
      const {width,height}=canvas.getBoundingClientRect(); const dpr=window.devicePixelRatio||1
      canvas.width=width*dpr;canvas.height=height*dpr
      const ctx=canvas.getContext('2d');if(!ctx)return
      // Resolve currentColor and CSS variables through CSS before passing a concrete color to Canvas.
      ctx.scale(dpr,dpr);ctx.fillStyle=getComputedStyle(canvas).color
      const samples=buffer?{sampleRate:buffer.sampleRate,channels:Array.from({length:buffer.numberOfChannels},(_,channel)=>buffer.getChannelData(channel))}:undefined
      const values=waveformColumns(peaks,Math.max(1,Math.floor(width/2)),{sourceDuration,offsetSeconds,durationSeconds},samples)
      const spacing=width/values.length
      // Audible length (trimmed to the source) so the fade-out ends where playback ends.
      const audible=Math.max(0,Math.min(durationSeconds,sourceDuration-offsetSeconds))
      const [fi,fo]=fadeIn>0||fadeOut>0?fadeLengths(audible,fadeIn,fadeOut):[0,0]
      const level=(i:number)=>{if(!fi&&!fo)return gain;const t=(i+.5)*durationSeconds/values.length;return t>audible?0:gain*envelopeAt(t,audible,fi,fo,inCurve,outCurve)}
      for(let i=0;i<values.length;i++){const h=Math.max(1,Math.min(1,values[i]*level(i))*height*.9);ctx.fillRect(i*spacing,(height-h)/2,Math.max(.5,spacing-.5),h)}
    }
    const observer=new ResizeObserver(draw);observer.observe(canvas);draw();return()=>observer.disconnect()
  },[peaks,buffer,sourceDuration,offsetSeconds,durationSeconds,color,className,appearanceKey,theme,gain,fadeIn,fadeOut,inCurve,outCurve])
  return <canvas ref={ref} className={`waveform ${className}`} style={{color}} aria-hidden="true"/>
}
