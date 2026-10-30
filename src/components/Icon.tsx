import type { CSSProperties } from 'react'

const paths: Record<string, string> = {
  play: 'm8 5 11 7-11 7Z', pause: 'M8 5v14M16 5v14', stop: 'M6 6h12v12H6Z',
  back: 'M5 5v14M19 5 8 12l11 7Z', loop: 'M4 8h13l-3-3M20 16H7l3 3M4 8v5M20 16v-5',
  volume: 'm11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
  headphones: 'M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2ZM20 12h-3v8h3a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2Z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', chevron: 'm8 10 4 4 4-4', right: 'm9 5 7 7-7 7',
  undo: 'M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5', redo: 'M21 10H10a6 6 0 0 0 0 12M21 10l-5-5M21 10l-5 5',
  save: 'M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-8h10v8', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5', folder: 'M3 6V4h7l3 3h8v13H3ZM3 10h18',
  search: 'M15.5 15.5 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  keys: 'M3 4h18v16H3ZM7 4v9h3V4M14 4v9h3V4M9 13v7M15 13v7',
  wave: 'M2 10v4M6 6v12M10 3v18M14 7v10M18 5v14M22 9v6',
  drum: 'M3 8c0-4 18-4 18 0s-18 4-18 0Zm0 0v9c0 4 18 4 18 0V8M8 11v9M16 11v9M7 2l9 4',
  synth: 'M2 15h3l3-8 5 13 4-16 3 11h2', note: 'M9 17V5l11-2v12M9 7l11-2M9 17c0 4-7 4-7 1s7-4 7-1ZM20 15c0 4-7 4-7 1s7-4 7-1Z',
  mixer: 'M5 3v18M12 3v18M19 3v18M2 8h6M9 16h6M16 7h6', settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  scissors: 'm8 8 12 12M14 10l6-6M8 16l3-3M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  copy: 'M8 8h13v13H8ZM16 8V3H3v13h5', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L20 5', info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  magnet: 'M5 3v10a7 7 0 0 0 14 0V3h-4v10a3 3 0 0 1-6 0V3ZM5 7h4M15 7h4',
  mic: 'M9 5a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0ZM5 11v2a7 7 0 0 0 14 0v-2M12 20v3M8 23h8',
  keyboard: 'M2 5h20v14H2ZM5 8h.01M8 8h.01M11 8h.01M14 8h.01M17 8h.01M5 11h.01M8 11h.01M11 11h.01M14 11h.01M17 11h.01M7 15h10',
  panel: 'M3 3h18v18H3ZM8 3v18', external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7Z', file: 'M14 2H4v20h16V8ZM14 2v6h6M8 13h8M8 17h5',
  moon: 'M20.8 14a9 9 0 0 1-10.8-10.8A9 9 0 1 0 20.8 14Z',
  metronome: 'm9 3-5 18h16L15 3ZM7 15h10M11 12l8-9',
}
export function Icon({ name, size = 18, className = '', style }: {name: string; size?: number; className?: string; style?: CSSProperties}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}><path d={paths[name] ?? paths.wave}/></svg>
}
