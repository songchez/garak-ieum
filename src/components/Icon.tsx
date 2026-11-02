import type { CSSProperties } from 'react'
import {
  Activity, AudioLines, Check, ChevronDown, ChevronLeft, ChevronRight, CircleSmall,
  ClipboardPaste, Combine, Copy, Download, Drum, EighthNotes, ExternalLink, Eye, EyeOff,
  FileHeadphone, FilePlus, FileText, Flag, Flame, FolderOpen, Funnel, Guitar, Headphones,
  Info, Keyboard, LayoutGrid, LibraryBig, ListMusic, LocateFixed, LockKeyhole, Magnet,
  Maximize, Metronome, Mic, MicVocal, Minimize2, Minus, Moon, MoveHorizontal, MoveVertical,
  Palette, PanelLeft, Pause, Piano, Play, Plug, Plus, Power, Redo2, RefreshCw, Repeat2,
  Save, Scissors, Search, Settings, SkipBack, SlidersHorizontal, SlidersVertical,
  Snowflake, Square, SquareDashed, SquareDashedMousePointer, TextCursorInput, Trash,
  Undo2, Upload, Volume2, VolumeX, WavesHorizontal, WavesVertical, Wind, X, Zap,
  type LucideIcon,
} from 'lucide-react'

// Keep app keys stable: saved projects can contain any of the original icon names.
// Named imports let the bundler include only this small, deliberate icon set.
const icons: Readonly<Record<string, LucideIcon>> = {
  play: Play, pause: Pause, stop: Square, back: SkipBack, loop: Repeat2,
  volume: Volume2, 'volume-off': VolumeX, headphones: Headphones, monitor: Headphones,
  plus: Plus, minus: Minus, chevron: ChevronDown, right: ChevronRight, left: ChevronLeft,
  undo: Undo2, redo: Redo2, save: Save, download: Download, upload: Upload, import: Upload,
  folder: FolderOpen, search: Search, file: FileText, 'file-plus': FilePlus, library: LibraryBig,
  keys: Piano, piano: Piano, wave: AudioLines, drum: Drum, synth: Activity, note: EighthNotes,
  guitar: Guitar, strings: WavesVertical, wind: Wind, pad: WavesHorizontal,
  mic: Mic, vocal: MicVocal, audio: FileHeadphone,
  mixer: SlidersVertical, settings: Settings, inspector: SlidersHorizontal,
  scissors: Scissors, cut: Scissors, copy: Copy, paste: ClipboardPaste, trash: Trash,
  rename: TextCursorInput, palette: Palette, region: SquareDashed, track: ListMusic,
  merge: Combine, 'select-all': SquareDashedMousePointer, flag: Flag,
  refresh: RefreshCw, locate: LocateFixed,
  close: X, check: Check, info: Info, grid: LayoutGrid, magnet: Magnet,
  keyboard: Keyboard, panel: PanelLeft, external: ExternalLink, bolt: Zap,
  moon: Moon, metronome: Metronome, plug: Plug, power: Power,
  fit: Maximize, arrowsH: MoveHorizontal, arrowsV: MoveVertical,
  lock: LockKeyhole, snowflake: Snowflake, eye: Eye, 'eye-off': EyeOff, dot: CircleSmall,
  eq: SlidersVertical, filter: Funnel, compressor: Minimize2,
  drive: Flame, delay: Repeat2, reverb: WavesHorizontal,
}

export function Icon({ name, size = 18, className = '', style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  const Glyph = Object.hasOwn(icons, name) ? icons[name] : AudioLines
  // Scale strokes with size so the 9–12 px editor glyphs retain open details.
  return <Glyph size={size} strokeWidth={1.8} aria-hidden="true" focusable="false" className={className} style={style} />
}
