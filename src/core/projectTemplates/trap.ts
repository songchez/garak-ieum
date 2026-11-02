import type { Project } from '../types'
import { insert, part, phrase, sectionAt, session, type Event, type Section } from './shared'

const SECTIONS: readonly Section[] = [
  { name: '수면 · Intro', bar: 0, bars: 4, kind: 'intro' },
  { name: '첫 물결 · Verse A', bar: 4, bars: 8, kind: 'verse' },
  { name: '너울 · Hook', bar: 12, bars: 8, kind: 'hook' },
  { name: '물밑 · Break', bar: 20, bars: 4, kind: 'break' },
  { name: '깊은 물결 · Verse B', bar: 24, bars: 8, kind: 'verse' },
  { name: '큰 너울 · Final hook', bar: 32, bars: 12, kind: 'return' },
  { name: '잔물결 · Outro', bar: 44, bars: 4, kind: 'outro' },
]

const MOTIFS: readonly (readonly Event[])[] = [
  [[66, 0, 0.45, 0.84], [73, 0.75, 0.24, 0.62], [69, 1.5, 0.35, 0.69], [66, 2.75, 0.5, 0.77],
    [64, 4, 0.5, 0.65], [66, 5.5, 0.4, 0.74], [61, 6.75, 0.8, 0.63]],
  [[66, 0, 0.5, 0.82], [69, 1.25, 0.28, 0.66], [71, 1.75, 0.35, 0.72], [73, 3, 0.5, 0.8],
    [76, 4.5, 0.55, 0.7], [73, 5.5, 0.3, 0.6], [69, 6.25, 0.35, 0.66], [66, 7.25, 0.5, 0.75]],
  [[66, 0, 0.35, 0.86], [78, 0.75, 0.3, 0.69], [76, 1.5, 0.35, 0.73], [73, 2.5, 0.6, 0.8],
    [71, 4, 0.35, 0.72], [69, 4.75, 0.3, 0.64], [66, 5.5, 0.7, 0.83], [64, 7, 0.6, 0.65]],
  [[69, 0, 0.5, 0.82], [73, 1, 0.35, 0.7], [76, 1.75, 0.4, 0.76], [78, 3, 0.7, 0.83],
    [73, 4.25, 0.6, 0.72], [69, 5.25, 0.4, 0.64], [68, 6, 0.35, 0.59], [66, 7, 0.7, 0.77]],
]

export function createHeukryuTrap(): Project {
  const project = session('검은 물결', 144, 48, SECTIONS)
  const kick = part('kit-808', '808 · 짧은 킥', 0.46, 0, { tone: -0.12 })
  const snare = part('kit-808', '808 · 하프타임 클랩', 0.38, 0.04)
  insert(snare, 'reverb', { amount: 0.09, size: 0.12, tone: 6000 })
  const hats = part('kit-808', '808 · 잔물결 하이햇', 0.2, 0.18, { tone: -0.18 })
  const buk = part('samul', '북 · 파도의 발', 0.29, -0.09)
  const janggu = part('samul', '장구 · 엇박 응답', 0.22, -0.2)
  const metal = part('samul', '징 · 수평선', 0.12, 0.23)
  insert(metal, 'reverb', { amount: 0.2, size: 0.4, tone: 5500 })
  const bass = part('bass', '서브 베이스 · 저류', 0.52, 0,
    { tone: -0.55, sub: 0.92, attack: 0.008, decay: 0.16, sustain: 0.7, release: 0.15 })
  const gaya = part('gayageum', '가야금 · 검은 물결', 0.45, -0.18, { tone: 0.12, release: 0.27 })
  insert(gaya, 'delay', { amount: 0.12, time: 0.75, feedback: 0.22, tone: 3400 })
  insert(gaya, 'reverb', { amount: 0.12, size: 0.27, tone: 6500 })
  const daegeum = part('daegeum', '대금 · 너울의 선', 0.21, 0.12, { attack: 0.018, release: 0.28, tone: -0.12 })
  insert(daegeum, 'reverb', { amount: 0.22, size: 0.44, tone: 5800 })
  const haegeum = part('haegeum', '해금 · 먼 불빛', 0.21, -0.05, { attack: 0.05, release: 0.45, tone: -0.2 })
  insert(haegeum, 'reverb', { amount: 0.23, size: 0.42, tone: 5000 })
  const pad = part('pad', '어둑한 화음', 0.16, 0.14,
    { tone: -0.48, attack: 0.3, decay: 0.5, sustain: 0.55, release: 0.55, detune: 4 })
  insert(pad, 'filter', { cutoff: 1500, resonance: 0.6, mode: 0 })
  project.tracks = [kick, snare, hats, buk, janggu, metal, bass, gaya, daegeum, haegeum, pad]

  for (let bar = 0; bar < 48; bar += 2) {
    const section = sectionAt(SECTIONS, bar)
    const local = bar - section.bar
    const turn = local + 2 === section.bars
    const hook = section.kind === 'hook' || section.kind === 'return'
    const intro = section.kind === 'intro'
    const breath = section.kind === 'break'
    const outro = section.kind === 'outro'
    const last = bar === 46
    const variation = (local / 2 + (bar >= 24 ? 1 : 0)) % 4
    const root = [30, 28, 26, 25][variation]
    const label = section.name.split(' · ')[0]

    if (!intro && !breath && !last) {
      const starts = hook ? [0, 0.75, 1.5, 3.25, 4, 5.5, 6.75] : variation % 2 ? [0, 1.5, 3.5, 4.75, 6.5] : [0, 1.75, 4, 5.5, 7.25]
      const events = starts.map((start, i): Event => [35, start, 0.12, i % 3 === 0 ? 0.88 : 0.68])
      if (hook && turn) events.push([35, 7.5, 0.1, 0.57], [35, 7.75, 0.1, 0.65])
      phrase(kick, `${label} · 킥 ${variation + 1}`, bar, 2, events, outro ? 0.72 : 1)
      const backbeat: Event[] = [[38, 2, 0.15, 0.78], [39, 2.012, 0.16, 0.58], [38, 6, 0.15, 0.84], [39, 6.012, 0.16, 0.64]]
      if (hook || turn) backbeat.push([40, 5.75, 0.09, 0.3], [40, 7.5, 0.1, 0.41])
      if (turn && !outro) backbeat.push([38, 7.75, 0.12, 0.55])
      phrase(snare, '세 번째 박 · 하프타임', bar, 2, backbeat, outro ? 0.75 : 1)
    }

    if (!last && (!intro || local === 2) && (!breath || local === 2)) {
      const events: Event[] = []
      const step = hook ? 0.25 : 0.5
      const roll = (hook || turn) && !outro
      for (let t = 0; t < (roll ? 7 : 8); t += step) {
        if (outro && t >= 4) break
        const open = !intro && (t === 3.5 || (variation % 2 === 1 && t === 5.5))
        const index = Math.round(t / step)
        events.push([open ? 46 : 42, t, open ? 0.2 : 0.055, open ? 0.43 : [0.58, 0.27, 0.43, 0.32][index % 4]])
      }
      if (roll) {
        const divisions = variation % 2 ? 6 : 8
        for (let i = 0; i < divisions; i++) events.push([42, 7 + i / divisions, 0.045, 0.31 + 0.045 * i])
      }
      phrase(hats, roll ? '하이햇 · 밀려오는 롤' : '하이햇 · 여백', bar, 2, events, intro || breath ? 0.7 : outro ? 0.55 : 1)
    }

    phrase(buk, last ? '북 · 마지막 물방울' : `${label} · 북`, bar, 2,
      last ? [[36, 0, 0.3, 0.5]] : [
        [36, 0, 0.24, 0.7], [36, 4, 0.24, 0.62],
        ...(hook || breath ? [[45, 3.25, 0.18, 0.4], [36, 6.75, 0.2, 0.52]] as Event[] : []),
      ], outro ? 0.6 : 1)

    if (!last && (!intro || local === 2)) {
      const events: Event[] = [
        [41, 0.75, 0.17, 0.54], [40, 2.75, 0.1, 0.47], [38, 4.75, 0.16, 0.59], [39, 6.5, 0.1, 0.42],
      ]
      if (hook || breath || turn) events.push([41, 7, 0.13, 0.54], [43, 7 + 1 / 3, 0.09, 0.42], [40, 7 + 2 / 3, 0.1, 0.63])
      phrase(janggu, breath ? '장구 · 물밑의 대답' : '장구 · 비트 사이', bar, 2, events, breath ? 1.12 : outro ? 0.6 : 1)
    }

    if (local === 0 || (hook && turn)) {
      const events: Event[] = [[intro || outro ? 51 : 49, 0, 0.7, intro ? 0.5 : 0.6]]
      if (hook) events.push([42, 4, 0.2, 0.4], [44, 7.5, 0.2, 0.32])
      phrase(metal, '징 · 수평선이 열리다', bar, 2, events, outro ? 0.65 : 1)
    }

    if (!last && (!intro || local === 2) && (!breath || local === 2)) {
      const events: Event[] = [
        [root, 0, 1.45, 0.81], [root, 1.75, 1.1, 0.65], [root, 4, 1.3, 0.77], [root, 5.5, 1.1, 0.71],
      ]
      if (hook) events.push([root + 12, 3.25, 0.45, 0.57], [root + 12, 7, 0.6, 0.61])
      else events.push([root, 7.25, 0.5, 0.6])
      phrase(bass, `${['F♯', 'E', 'D', 'C♯'][variation]} · 저류`, bar, 2, events, intro || outro ? 0.68 : 1)
    }

    if (last) {
      phrase(gaya, '가야금 · F♯로 가라앉다', bar, 2, [[69, 0, 0.6, 0.58], [68, 1.25, 0.45, 0.48], [66, 2.5, 1.4, 0.65], [54, 4.5, 1.8, 0.5]], 0.7)
    } else {
      const motif = MOTIFS[hook ? 2 + variation % 2 : variation % 2]
      const events = breath ? motif.filter(([, start]) => local === 0 ? start < 4 : start >= 4) : motif
      phrase(gaya, `${label} · 가야금 ${variation + 1}`, bar, 2, events, outro ? 0.7 : 1)
    }

    if (hook && variation % 2 === 0) {
      phrase(daegeum, '대금 · 너울', bar, 2, [
        [78, 0.5, 0.9, 0.63], [76, 1.75, 0.5, 0.55], [73, 3, 1.1, 0.66],
        [71, 5, 0.6, 0.55], [69, 6, 0.65, 0.6], [66, 7, 0.7, 0.57],
      ])
    } else if (breath && local === 0) {
      phrase(daegeum, '대금 · 물밑 독백', bar, 2, [[66, 3, 1.2, 0.6], [69, 5, 0.8, 0.54], [73, 6.5, 1, 0.64]])
    }
    if ((intro && local === 2) || (hook && variation % 2 === 1) || (section.kind === 'verse' && turn)) {
      phrase(haegeum, '해금 · 먼 불빛의 응답', bar, 2, [
        [66, 1, 1.3, 0.56], [69, 3, 1.2, 0.61], [68, 5, 0.8, 0.56], [66, 6.5, 1.2, 0.6],
      ], intro ? 0.78 : 1)
    }
    if (hook || (breath && local === 0)) {
      const chord = [[54, 57, 61], [52, 56, 59], [50, 54, 57], [49, 52, 56]][variation]
      phrase(pad, `${label} · 낮은 안개`, bar, 2,
        chord.map((pitch, voice): Event => [pitch, voice * 0.025, 6.3, 0.42 + voice * 0.025]), breath ? 0.72 : 1)
    }
  }
  return project
}
