/** Appearance belongs to this browser, never to a project or its Undo history. */
export const THEME_STORAGE_KEY = 'garak-ieum:theme:v1'
export const THEME_IDS = ['dawn-hanok', 'dancheong', 'porcelain', 'celadon', 'natural-dyes', 'earthy'] as const
export type ThemeId = typeof THEME_IDS[number]
export const DEFAULT_THEME: ThemeId = 'dawn-hanok'

export interface ThemeColors {
  base: string; canvas: string; canvasAlt: string; panel: string; panelSoft: string
  raised: string; overlay: string; hover: string; selected: string; input: string
  text: string; secondary: string; muted: string; disabled: string; inverse: string
  borderSubtle: string; border: string; borderStrong: string
  accent: string; accentHover: string; accentStrong: string; accentBorder: string
  brand: string; brandHover: string; brass: string; loopFill: string
  play: string; playHover: string; record: string; playhead: string
  success: string; danger: string; warning: string
  giwa: string; giwaEdge: string
  meterEmpty: string; meterLow: string; meterMid: string; meterHigh: string
  onAccent: string; onPlay: string; onRecord: string; onBrass: string; onTrack: string
}
export interface ThemeSwatch { name: string; color: string; role: string }
export interface ThemeDefinition {
  id: ThemeId
  name: string
  subtitle: string
  mode: 'light' | 'dark'
  description: string
  palette: readonly ThemeSwatch[]
  colors: Readonly<ThemeColors>
  tokens: Readonly<Record<string, string>>
}

const dawn: ThemeColors = {
  base:'#232927', canvas:'#252c28', canvasAlt:'#29302b', panel:'#303831', panelSoft:'#343c35',
  raised:'#394139', overlay:'#3d453c', hover:'#454d43', selected:'#3b4b40', input:'#252c28',
  text:'#eee9dc', secondary:'#cdd0c1', muted:'#b8beaf', disabled:'#838c7d', inverse:'#202821',
  borderSubtle:'#465046', border:'#5b675a', borderStrong:'#82917c',
  accent:'#9bc8b5', accentHover:'#b4dac9', accentStrong:'#86b5a0', accentBorder:'#729c86',
  brand:'#e0a08a', brandHover:'#edbba6', brass:'#d4ba7e', loopFill:'#d4ba7e',
  play:'#9dcba5', playHover:'#b8ddbd', record:'#e5533d', playhead:'#f0e2be',
  success:'#b4dac9', danger:'#f1b0a1', warning:'#e6c481', giwa:'#39423b', giwaEdge:'#647062',
  meterEmpty:'#212824', meterLow:'#83bd9c', meterMid:'#d4ba7e', meterHigh:'#ed8d77',
  onAccent:'#202821', onPlay:'#202821', onRecord:'#ffffff', onBrass:'#202821', onTrack:'#202821',
}

const definitions: Omit<ThemeDefinition, 'tokens'>[] = [
  { id:'dawn-hanok', name:'새벽 한옥', subtitle:'기존 테마', mode:'dark',
    description:'먹회색 작업실에 청자빛 선택과 한지색 글자를 담았습니다.', colors:dawn,
    palette:[{name:'먹회색',color:'#303831',role:'패널'},{name:'한지빛',color:'#eee9dc',role:'글자'},{name:'청자빛',color:'#9bc8b5',role:'선택·포커스'},{name:'석간주빛',color:'#e0a08a',role:'브랜드'},{name:'황동빛',color:'#d4ba7e',role:'루프'}],
  },
  { id:'dancheong', name:'단청', subtitle:'Dancheong', mode:'dark',
    description:'뇌록의 깊은 바탕 위에 황단의 선택 표시와 장단의 녹음 표시를 올렸습니다.',
    palette:[{name:'뇌록',color:'#3D7865',role:'선택 경계·녹청 바탕'},{name:'석간주',color:'#8B3A2B',role:'기와 장식'},{name:'장단',color:'#DF5435',role:'녹음·강조'},{name:'삼청',color:'#285973',role:'입력 필드'},{name:'황단',color:'#E6A838',role:'선택·루프'}],
    colors:{
      base:'#192b28',canvas:'#1f302d',canvasAlt:'#243832',panel:'#2b4138',panelSoft:'#30483d',
      raised:'#345043',overlay:'#395649',hover:'#3d5c4c',selected:'#315c4d',input:'#285973',
      text:'#f8f1df',secondary:'#e5eadc',muted:'#d1ddcd',disabled:'#93a79a',inverse:'#25352b',
      borderSubtle:'#3c6253',border:'#5c7c67',borderStrong:'#91ac8d',
      accent:'#f3c86d',accentHover:'#ffdc8c',accentStrong:'#f3c86d',accentBorder:'#3d7865',
      brand:'#f9c5b3',brandHover:'#ffe0cf',brass:'#f3c86d',loopFill:'#e6a838',
      play:'#b4d5b0',playHover:'#d0e6c9',record:'#df5435',playhead:'#f6dc9b',
      success:'#b4d5b0',danger:'#ffc0a9',warning:'#f3c86d',giwa:'#8b3a2b',giwaEdge:'#df5435',
      meterEmpty:'#182d24',meterLow:'#8bc4a2',meterMid:'#e6a838',meterHigh:'#f18f72',
      onAccent:'#25352b',onPlay:'#25352b',onRecord:'#111a15',onBrass:'#25352b',onTrack:'#202821',
    },
  },
  { id:'porcelain', name:'백자와 수묵', subtitle:'White Porcelain & Ink', mode:'light',
    description:'유백 작업면과 한지 문살의 따뜻한 경계, 회백색 기와에 선명한 청화색 선택을 더했습니다.',
    palette:[{name:'유백',color:'#F8F6F0',role:'작업면·패널'},{name:'한지',color:'#ECE7DC',role:'배경·구획'},{name:'담묵',color:'#8C8B88',role:'경계·비활성 표시'},{name:'농묵',color:'#202124',role:'본문·눈금'},{name:'청화',color:'#2A4B7C',role:'선택·포커스'}],
    colors:{
      base:'#e7dece',canvas:'#f8f6f0',canvasAlt:'#eee8dc',panel:'#f8f6f0',panelSoft:'#e9dfcd',
      raised:'#fffdf7',overlay:'#fffefa',hover:'#e2d6c2',selected:'#d7e5f4',input:'#fffefa',
      text:'#202124',secondary:'#3d4146',muted:'#52534f',disabled:'#817b71',inverse:'#f8f6f0',
      borderSubtle:'#c2b49c',border:'#9c886b',borderStrong:'#75654d',
      accent:'#244f86',accentHover:'#193e70',accentStrong:'#193e70',accentBorder:'#42689a',
      brand:'#2a4b7c',brandHover:'#203b63',brass:'#745012',loopFill:'#d9b458',
      play:'#286044',playHover:'#204e38',record:'#a83428',playhead:'#244f86',
      success:'#286044',danger:'#982d23',warning:'#745012',giwa:'#b5b6aa',giwaEdge:'#6e7569',
      meterEmpty:'#d4cbbb',meterLow:'#2f7357',meterMid:'#87570f',meterHigh:'#a83428',
      onAccent:'#f8f6f0',onPlay:'#f8f6f0',onRecord:'#ffffff',onBrass:'#202124',onTrack:'#202124',
    },
  },
  { id:'celadon', name:'고려비색과 상감', subtitle:'Goryeo Celadon', mode:'light',
    description:'백상감처럼 밝은 면에 담록 구획과 짙은 상감선을 두르고 비색 기와를 올렸습니다.',
    palette:[{name:'비색',color:'#7BA59D',role:'선택 경계·기와'},{name:'담록',color:'#C4D8D1',role:'배경·선택 면'},{name:'백상감',color:'#E5E4DD',role:'패널·작업 구획'},{name:'흑상감',color:'#3C4340',role:'본문·눈금'}],
    colors:{
      base:'#c4d8d1',canvas:'#f2f6ef',canvasAlt:'#e2ece2',panel:'#edf1e8',panelSoft:'#d5e4da',
      raised:'#f8faf3',overlay:'#fafcf5',hover:'#cbded2',selected:'#c4dcd1',input:'#fbfdf7',
      text:'#3c4340',secondary:'#354d43',muted:'#43574c',disabled:'#748579',inverse:'#f4f5ed',
      borderSubtle:'#a4bcae',border:'#6c8978',borderStrong:'#536f60',
      accent:'#1f5849',accentHover:'#174738',accentStrong:'#1f5849',accentBorder:'#3e7a65',
      brand:'#285c50',brandHover:'#214c42',brass:'#5f4813',loopFill:'#b9b482',
      play:'#205848',playHover:'#174738',record:'#a63c31',playhead:'#1f5849',
      success:'#205848',danger:'#963d32',warning:'#5f4813',giwa:'#99b3a6',giwaEdge:'#4e7262',
      meterEmpty:'#b7ccbd',meterLow:'#2a6851',meterMid:'#795e17',meterHigh:'#a63c31',
      onAccent:'#f4f5ed',onPlay:'#f4f5ed',onRecord:'#ffffff',onBrass:'#3c4340',onTrack:'#202821',
    },
  },
  { id:'natural-dyes', name:'천연염색 한복', subtitle:'Natural Dyes', mode:'light',
    description:'비단빛 작업면과 따뜻한 목재 경계에 소목 강조, 옥색 선택 면과 회청색 기와를 배치했습니다.',
    palette:[{name:'쪽빛',color:'#2C4A6F',role:'선택·포커스·본문'},{name:'홍화',color:'#E07A6F',role:'녹음 계열 강조'},{name:'치자',color:'#E2A944',role:'루프 면'},{name:'소목',color:'#783645',role:'브랜드·강조'},{name:'옥색',color:'#A3C6C0',role:'선택 면·경계'}],
    colors:{
      base:'#e9decf',canvas:'#faf5ec',canvasAlt:'#f0e4d6',panel:'#f7efe4',panelSoft:'#e9d8c6',
      raised:'#fff9f0',overlay:'#fffbf4',hover:'#e5d3c1',selected:'#c8ded6',input:'#fffcf6',
      text:'#2c3e56',secondary:'#3e4a5d',muted:'#52515b',disabled:'#8b7e77',inverse:'#fff9f0',
      borderSubtle:'#c7b099',border:'#99795f',borderStrong:'#7a5e49',
      accent:'#274a73',accentHover:'#1b3a60',accentStrong:'#1b3a60',accentBorder:'#426f6a',
      brand:'#783645',brandHover:'#642937',brass:'#70470b',loopFill:'#e2a944',
      play:'#2b5f50',playHover:'#234e41',record:'#a63c39',playhead:'#783645',
      success:'#2b5f50',danger:'#983d39',warning:'#70470b',giwa:'#a6b5b9',giwaEdge:'#5a6d7b',
      meterEmpty:'#d3c5b2',meterLow:'#2d6954',meterMid:'#875a13',meterHigh:'#a63c39',
      onAccent:'#fff9f0',onPlay:'#fff9f0',onRecord:'#ffffff',onBrass:'#2c3e56',onTrack:'#202821',
    },
  },
  { id:'earthy', name:'돌담과 기와', subtitle:'Earthy Architecture', mode:'dark',
    description:'기와색 패널과 솔잎색 선택 면에 황토빛 조절기, 화강석 경계를 놓았습니다.',
    palette:[{name:'기와',color:'#373C42',role:'패널·기와'},{name:'화강석',color:'#9C978F',role:'경계·비활성 표시'},{name:'황토',color:'#B27C56',role:'선택 경계·따뜻한 강조'},{name:'솔잎',color:'#2D3F33',role:'선택 면'}],
    colors:{
      base:'#23282a',canvas:'#2b3034',canvasAlt:'#30363a',panel:'#373c42',panelSoft:'#3e4347',
      raised:'#41474b',overlay:'#454b50',hover:'#4e5457',selected:'#2d3f33',input:'#272d30',
      text:'#f2ece2',secondary:'#ddd6ca',muted:'#cfc7bc',disabled:'#9c978f',inverse:'#2d302b',
      borderSubtle:'#50565a',border:'#6f7373',borderStrong:'#9c978f',
      accent:'#e7c9a9',accentHover:'#f5ddc0',accentStrong:'#e3c09e',accentBorder:'#b27c56',
      brand:'#eacaa8',brandHover:'#f5ddc0',brass:'#e3c68b',loopFill:'#d5b774',
      play:'#bfd4ba',playHover:'#d0dfcb',record:'#d96149',playhead:'#ead7b6',
      success:'#bfd3bb',danger:'#f9c5b3',warning:'#e2c58a',giwa:'#373c42',giwaEdge:'#9c978f',
      meterEmpty:'#252d28',meterLow:'#9abc91',meterMid:'#d5b774',meterHigh:'#ee997f',
      onAccent:'#2d302b',onPlay:'#2d302b',onRecord:'#111a15',onBrass:'#2d302b',onTrack:'#202821',
    },
  },
]

function mix(from: string, to: string, amount: number): string {
  const a = from.slice(1).match(/../g)!.map(value => Number.parseInt(value,16))
  const b = to.slice(1).match(/../g)!.map(value => Number.parseInt(value,16))
  return `#${a.map((value,index) => Math.round(value+(b[index]-value)*amount).toString(16).padStart(2,'0')).join('')}`
}

function tokensFor(def: Omit<ThemeDefinition, 'tokens'>): Record<string,string> {
  const c=def.colors
  const tokens: Record<string,string> = {
    '--surface-base':c.base,'--surface-canvas':c.canvas,'--surface-canvas-alt':c.canvasAlt,
    '--surface-panel':c.panel,'--surface-panel-soft':c.panelSoft,'--surface-raised':c.raised,
    '--surface-overlay':c.overlay,'--surface-hover':c.hover,'--surface-selected':c.selected,'--surface-input':c.input,
    '--text-primary':c.text,'--text-secondary':c.secondary,'--text-muted':c.muted,'--text-disabled':c.disabled,'--text-inverse':c.inverse,
    '--border-subtle':c.borderSubtle,'--border-default':c.border,'--border-strong':c.borderStrong,
    '--accent':c.accent,'--accent-hover':c.accentHover,'--accent-strong':c.accentStrong,'--accent-border':c.accentBorder,'--focus':c.accent,
    '--brand-accent':c.brand,'--brand-accent-hover':c.brandHover,'--brass':c.brass,'--loop-fill':c.loopFill,
    '--play':c.play,'--play-hover':c.playHover,'--record':c.record,'--playhead':c.playhead,
    '--success':c.success,'--danger':c.danger,'--warning':c.warning,
    '--giwa':c.giwa,'--giwa-edge':c.giwaEdge,
    '--meter-empty':c.meterEmpty,'--meter-low':c.meterLow,'--meter-mid':c.meterMid,'--meter-high':c.meterHigh,
    '--on-accent':c.onAccent,'--on-play':c.onPlay,'--on-record':c.onRecord,'--on-brass':c.onBrass,'--on-track-color':c.onTrack,
    '--hanji':c.playhead,
    // Paper and timber are materials; --hanji is the legacy playhead color.
    '--hanji-surface':c.panel,'--paper-edge':mix(c.panel,'#ffffff',.65),
    '--hanok-frame':def.mode==='light'?c.borderStrong:c.border,
    '--control-border':def.mode==='light'?c.borderStrong:c.border,
    '--grid-major':def.mode==='light'?mix(c.canvas,c.muted,.48):'color-mix(in srgb,var(--text-muted) 21%,transparent)',
    '--grid-minor':def.mode==='light'?mix(c.canvas,c.muted,.19):'color-mix(in srgb,var(--text-muted) 9%,transparent)',
  }
  // Legacy numbered tokens remain a surface-to-foreground ramp in both brightness modes.
  for(let level=9;level<=30;level++) tokens[`--ink-${String(level).padStart(2,'0')}`]=mix(c.raised,c.text,(level-9)/100)
  for(let level=33;level<=99;level+=3) tokens[`--ink-${level}`]=mix(c.disabled,c.text,(level-33)/66)
  Object.assign(tokens,{'--ink-09':c.base,'--ink-10':c.canvas,'--ink-11':c.canvasAlt,'--ink-12':c.panel,'--ink-13':c.panelSoft,'--ink-14':c.raised,'--ink-15':c.overlay,'--ink-18':c.hover,'--ink-21':c.hover,'--ink-33':c.borderStrong,'--ink-39':c.disabled,'--ink-42':c.disabled,'--ink-45':c.muted,'--ink-54':c.muted,'--ink-63':c.secondary,'--ink-96':c.text,'--ink-99':c.text})
  for(const level of [36,42,54,57,60,63,66,69]) tokens[`--seokganju-${level}`]=mix(c.brand,c.brandHover,(level-36)/33)
  const swatches=def.palette
  tokens['--dancheong-red']=def.id==='dancheong'?'#df5435':def.id==='natural-dyes'?'#e07a6f':c.record
  tokens['--dancheong-green']=def.id==='dancheong'?'#3d7865':def.id==='natural-dyes'?'#a3c6c0':c.play
  tokens['--dancheong-blue']=def.id==='dancheong'?'#285973':c.accent
  tokens['--dancheong-gold']=c.loopFill
  swatches.forEach((swatch,index)=>{tokens[`--theme-palette-${index+1}`]=swatch.color})
  return tokens
}

export const THEMES: readonly ThemeDefinition[] = definitions.map(def=>Object.freeze({...def,tokens:Object.freeze(tokensFor(def))}))
export const isThemeId=(value:unknown):value is ThemeId=>typeof value==='string'&&(THEME_IDS as readonly string[]).includes(value)
export const themeDefinition=(id:ThemeId):ThemeDefinition=>THEMES.find(theme=>theme.id===id)!

export function loadTheme(): ThemeId {
  try { const saved=localStorage.getItem(THEME_STORAGE_KEY); return isThemeId(saved)?saved:DEFAULT_THEME }
  catch { return DEFAULT_THEME }
}
function saveTheme(id:ThemeId):boolean {
  try { localStorage.setItem(THEME_STORAGE_KEY,id); return true }
  catch { return false }
}

let currentTheme:ThemeId=DEFAULT_THEME
const listeners=new Set<()=>void>()
export const getThemeSnapshot=():ThemeId=>currentTheme
export const subscribeTheme=(listener:()=>void):(()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}

function applyTheme(id:ThemeId):void {
  const definition=themeDefinition(id)
  if(typeof document!=='undefined'){
    const root=document.documentElement
    root.dataset.theme=id;root.dataset.themeMode=definition.mode
    root.style.colorScheme=definition.mode
    // The default keeps the exact existing compatibility ramp from styles.css.
    for(const name of Object.keys(definition.tokens)){
      if(id==='dawn-hanok'&&!['--success','--danger','--warning','--loop-fill','--meter-empty','--meter-low','--meter-mid','--meter-high','--on-accent','--on-play','--on-record','--on-brass','--on-track-color'].includes(name))root.style.removeProperty(name)
      else root.style.setProperty(name,definition.tokens[name])
    }
    // Four-color palettes must not keep the fifth swatch of the previous theme.
    if(definition.palette.length<5)root.style.removeProperty('--theme-palette-5')
  }
  if(currentTheme!==id){currentTheme=id;for(const listener of [...listeners])listener()}
}

/** Applies before React mounts to avoid a flash of the wrong appearance. */
export function initializeTheme():void { applyTheme(loadTheme()) }

/** Theme changes are immediate; a storage failure keeps the current session usable. */
export function setTheme(id:ThemeId):{persisted:boolean} {
  if(!isThemeId(id))throw new Error('지원하지 않는 화면 테마입니다.')
  applyTheme(id)
  return{persisted:saveTheme(id)}
}
