import { useEffect, useRef } from 'react'
export function Waveform({peaks, color='currentColor', className=''}: {peaks:number[];color?:string;className?:string}) {
  const ref=useRef<HTMLCanvasElement>(null)
  useEffect(()=>{
    const canvas=ref.current; if(!canvas)return
    const draw=()=>{
      const {width,height}=canvas.getBoundingClientRect(); const dpr=window.devicePixelRatio||1
      canvas.width=width*dpr;canvas.height=height*dpr
      const ctx=canvas.getContext('2d');if(!ctx)return
      ctx.scale(dpr,dpr);ctx.fillStyle=color==='currentColor'?getComputedStyle(canvas).color:color
      const n=Math.max(1,Math.floor(width/3));
      for(let i=0;i<n;i++){let p=0;const a=Math.floor(i*peaks.length/n);const b=Math.max(a+1,Math.floor((i+1)*peaks.length/n));for(let j=a;j<b;j++)p=Math.max(p,peaks[j]??0);const h=Math.max(1,p*height*.9);ctx.fillRect(i*3,(height-h)/2,1.5,h)}
    }
    const observer=new ResizeObserver(draw);observer.observe(canvas);draw();return()=>observer.disconnect()
  },[peaks,color])
  return <canvas ref={ref} className={`waveform ${className}`} aria-hidden="true"/>
}
