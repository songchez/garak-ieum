import { useId, type CSSProperties } from 'react'
import './GiwaEave.css'

export interface GiwaEaveProps {
  className?: string
  compact?: boolean
  style?: CSSProperties
}

/** A fixed-pitch row of round and concave tiles, with lifted eave ends. */
export function GiwaEave({ className = '', compact = false, style }: GiwaEaveProps) {
  const id = `giwa-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const scale = compact ? 0.75 : 1
  const height = 12 * scale

  return <svg className={`giwa-eave${compact ? ' giwa-eave--compact' : ''}${className ? ` ${className}` : ''}`}
    xmlns="http://www.w3.org/2000/svg" width="100%" height={height} style={style}
    aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-round`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="var(--giwa-rim)"/>
        <stop offset=".2" stopColor="var(--giwa-shade)"/>
        <stop offset=".42" stopColor="var(--giwa-highlight)"/>
        <stop offset=".65" stopColor="var(--giwa)"/>
        <stop offset="1" stopColor="var(--giwa-shade)"/>
      </linearGradient>
      <linearGradient id={`${id}-valley`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--giwa)"/>
        <stop offset=".5" stopColor="var(--giwa-shade)"/>
        <stop offset="1" stopColor="var(--giwa-rim)"/>
      </linearGradient>
      <radialGradient id={`${id}-cap`} cx=".38" cy=".3" r=".75">
        <stop offset="0" stopColor="var(--giwa-highlight)"/>
        <stop offset=".56" stopColor="var(--giwa)"/>
        <stop offset="1" stopColor="var(--giwa-shade)"/>
      </radialGradient>
      <pattern id={`${id}-tiles`} width="28" height="12" patternUnits="userSpaceOnUse" patternTransform={`scale(${scale})`}>
        <path d="M0 0H28V8.8H0Z" fill="var(--giwa-shade)"/>
        <path d="M0 2.2C4.5 4.9 10.5 4.9 15 2.2V6.5C10.5 9.5 4.5 9.5 0 6.5Z" fill={`url(#${id}-valley)`}/>
        <path d="M0 2.2C4.5 4.9 10.5 4.9 15 2.2" fill="none" stroke="var(--giwa-highlight)" strokeWidth=".6"/>
        <path d="M0 6.5C4.5 9.5 10.5 9.5 15 6.5" fill="none" stroke="var(--giwa-rim)" strokeWidth=".75"/>
        <path d="M16.2 0H23.8V7.1H16.2Z" fill={`url(#${id}-round)`}/>
        <path d="M17.6 .5V5.4" stroke="var(--giwa-highlight)" strokeWidth=".55" strokeOpacity=".8"/>
        <circle cx="20" cy="7" r="3.7" fill={`url(#${id}-cap)`} stroke="var(--giwa-rim)" strokeWidth=".7"/>
        <circle cx="20" cy="7" r="2.3" fill="none" stroke="var(--giwa-highlight)" strokeWidth=".65"/>
        <circle cx="20" cy="7" r=".6" fill="var(--giwa-rim)"/>
        <path d="M0 .35H28" stroke="var(--giwa-highlight)" strokeWidth=".7" strokeOpacity=".55"/>
      </pattern>
    </defs>
    {/* No outer viewBox: the 28px repeat stays legible at every window width. */}
    <rect width="100%" height={height} fill={`url(#${id}-tiles)`}/>
    <rect y={11 * scale} width="100%" height={scale} fill="var(--giwa-timber)"/>
    <svg width={32 * scale} height={height} viewBox="0 0 32 12">
      <path d="M0 5.8C7 9.2 18 11.2 32 11.2V12H0Z" fill="var(--surface-panel)"/>
      <path d="M0 5.8C7 9.2 18 11.2 32 11.2" fill="none" stroke="var(--giwa-timber)" strokeWidth=".9"/>
    </svg>
    <svg x="100%" width={32 * scale} height={height} viewBox="0 0 32 12" overflow="visible">
      <g transform="scale(-1 1)">
        <path d="M0 5.8C7 9.2 18 11.2 32 11.2V12H0Z" fill="var(--surface-panel)"/>
        <path d="M0 5.8C7 9.2 18 11.2 32 11.2" fill="none" stroke="var(--giwa-timber)" strokeWidth=".9"/>
      </g>
    </svg>
  </svg>
}
