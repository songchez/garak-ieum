import type { Project } from '../types'
import { insert, part, phrase, sectionAt, session, type Event, type Section } from './shared'

const SECTIONS: readonly Section[] = [
  { name: '행렬이 오다 · Intro', bar: 0, bars: 4, kind: 'intro' },
  { name: '메기다 · Theme A', bar: 4, bars: 8, kind: 'verse' },
  { name: '함께 걷다 · Chorus', bar: 12, bars: 8, kind: 'hook' },
  { name: '돌아보다 · Break', bar: 20, bars: 4, kind: 'break' },
  { name: '받다 · Theme B', bar: 24, bars: 8, kind: 'verse' },
  { name: '달빛 행렬 · Return', bar: 32, bars: 4, kind: 'return' },
  { name: '멀어지는 발소리', bar: 36, bars: 4, kind: 'outro' },
]

const CALLS: readonly (readonly Event[])[] = [
  [[69, 0.5, 0.65, 0.7], [72, 1.5, 0.35, 0.61], [74, 2.25, 0.5, 0.68], [76, 3.25, 0.55, 0.75]],
  [[76, 0.25, 0.6, 0.73], [74, 1.25, 0.45, 0.62], [72, 2, 0.55, 0.67], [69, 3, 0.7, 0.73]],
  [[74, 0, 0.6, 0.74], [76, 1, 0.4, 0.66], [78, 1.75, 0.55, 0.72], [76, 3, 0.7, 0.78]],
  [[79, 0.5, 0.55, 0.72], [76, 1.5, 0.4, 0.64], [74, 2.25, 0.5, 0.68], [72, 3.25, 0.55, 0.73]],
]
const RESPONSES: readonly (readonly Event[])[] = [
  [[72, 4.25, 0.65, 0.64], [71, 5.25, 0.4, 0.57], [69, 6, 1.25, 0.7]],
  [[69, 4.5, 0.5, 0.63], [72, 5.25, 0.4, 0.59], [74, 6, 0.55, 0.68], [76, 7, 0.65, 0.7]],
  [[78, 4.25, 0.65, 0.67], [76, 5.25, 0.5, 0.6], [74, 6.25, 1.1, 0.71]],
  [[72, 4.25, 0.5, 0.65], [71, 5, 0.35, 0.57], [69, 5.75, 0.55, 0.66], [66, 6.75, 0.8, 0.62]],
]

export function createDalbitFusion(): Project {
  const project = session('달빛 행렬', 118, 40, SECTIONS)
  const drums = part('kit-acoustic', '드럼 · 앞으로 걷는 발', 0.54)
  insert(drums, 'compressor', { threshold: -18, ratio: 2.5, attack: 22, release: 140, makeup: 1 })
  const hats = part('kit-acoustic', '하이햇 & 라이드 · 빛', 0.24, 0.22)
  const low = part('bass', '베이스 1 · 낮은 걸음', 0.48, -0.04,
    { tone: -0.2, attack: 0.004, decay: 0.09, sustain: 0.48, release: 0.07, sub: 0.7 })
  const high = part('bass', '베이스 2 · 엇박 대화', 0.34, 0.14,
    { tone: 0.22, attack: 0.003, decay: 0.075, sustain: 0.28, release: 0.065, sub: 0.15 })
  insert(high, 'eq', { low: -5, mid: 1.5, midFreq: 1600, high: -1 })
  const buk = part('samul', '북 & 박 · 행렬의 발', 0.27, -0.12)
  const janggu = part('samul', '장구 · 맞물리는 손', 0.23, 0.13)
  const metal = part('samul', '꽹과리 & 징 · 달무리', 0.115, -0.25)
  insert(metal, 'reverb', { amount: 0.13, size: 0.27, tone: 6200 })
  const gaya = part('gayageum', '가야금 · 촘촘한 발걸음', 0.4, -0.22, { release: 0.22, tone: 0.08 })
  insert(gaya, 'reverb', { amount: 0.11, size: 0.2, tone: 7500 })
  const daegeum = part('daegeum', '대금 · 메기는 선율', 0.24, -0.04, { attack: 0.015, release: 0.25, tone: -0.04 })
  insert(daegeum, 'reverb', { amount: 0.17, size: 0.28, tone: 6800 })
  const haegeum = part('haegeum', '해금 · 받는 선율', 0.25, 0.09, { attack: 0.024, release: 0.29, tone: -0.12 })
  insert(haegeum, 'reverb', { amount: 0.15, size: 0.25, tone: 6100 })
  const keys = part('rhodes', '전기 피아노 · 달빛 화음', 0.2, 0.25,
    { tone: -0.24, decay: 0.8, release: 0.12, bark: 0.2 })
  project.tracks = [drums, hats, low, high, buk, janggu, metal, gaya, daegeum, haegeum, keys]

  for (let bar = 0; bar < 40; bar += 2) {
    const section = sectionAt(SECTIONS, bar)
    const local = bar - section.bar
    const turn = local + 2 === section.bars
    const hook = section.kind === 'hook' || section.kind === 'return'
    const intro = section.kind === 'intro'
    const breath = section.kind === 'break'
    const outro = section.kind === 'outro'
    const last = bar === 38
    const variation = (local / 2 + (bar >= 24 ? 1 : 0)) % 4
    const root = [33, 38, 31, 33][variation]
    const label = section.name.split(' · ')[0]

    if (!last && !breath && (!intro || local === 2)) {
      const events: Event[] = []
      for (let b = 0; b < 2; b++) {
        const offset = b * 4
        events.push([36, offset, 0.15, 0.82], [36, offset + 2, 0.14, 0.71],
          [38, offset + 1, 0.13, 0.73], [38, offset + 3, 0.13, 0.79])
        if (hook || (b === 1 && variation % 2 === 1)) events.push([36, offset + 2.75, 0.13, 0.6])
        if (variation % 2) events.push([37, offset + 1.75, 0.1, 0.37])
      }
      if (turn && !outro) events.push([40, 6.75, 0.09, 0.4], [45, 7.5, 0.12, 0.6], [43, 7.75, 0.12, 0.64])
      phrase(drums, turn ? '드럼 · 모퉁이를 돌다' : '드럼 · 곧은 걸음', bar, 2, events, intro || outro ? 0.76 : 1)
    }

    if (!last && (!intro || local === 2)) {
      const events: Event[] = []
      for (let i = 0; i < 16; i++) {
        if ((breath && i % 2) || (outro && i >= 8)) continue
        const ride = hook && variation % 2 === 1
        const open = !breath && !ride && (i === 7 || (turn && i === 15))
        events.push([ride ? 51 : open ? 46 : 42, i * 0.5, open ? 0.2 : 0.07,
          i % 2 ? 0.37 : i % 4 === 0 ? 0.65 : 0.52])
      }
      phrase(hats, hook && variation % 2 ? '라이드 · 열린 길' : '하이햇 · 달빛 맥박', bar, 2, events, breath || outro ? 0.65 : 1)
    }

    if (!last && (!breath || local === 2)) {
      const events: Event[] = []
      for (let b = 0; b < 2; b++) {
        const offset = b * 4
        events.push([root, offset, 0.42, 0.79], [root, offset + 0.75, 0.26, 0.56],
          [root + 7, offset + 1.5, 0.3, 0.64], [root, offset + 2.5, 0.42, 0.75],
          [root + 12, offset + 3.25, 0.32, 0.57])
      }
      phrase(low, `${['A', 'D', 'G', 'A'][variation]} · 낮은 걸음`, bar, 2, events, intro ? 0.74 : outro ? 0.65 : 1)
    }

    if (!last && !intro && (!breath || local === 0)) {
      const chord = [[45, 48, 52, 54], [50, 54, 57, 59], [43, 47, 50, 52], [45, 48, 52, 54]][variation]
      const events: Event[] = [
        [chord[2], 1.15, 0.22, 0.61], [chord[0], 2, 0.28, 0.63], [chord[1], 3.65, 0.2, 0.54],
        [chord[2], 4.65, 0.25, 0.64], [chord[3], 5.25, 0.26, 0.59], [chord[1], 6.75, 0.3, 0.66],
      ]
      if (hook) events.push([chord[0], 7.5, 0.28, 0.59])
      phrase(high, breath ? '위 베이스 · 혼자 남은 대화' : '위 베이스 · 빈 박을 채우다', bar, 2, events, breath ? 1.05 : outro ? 0.55 : 1)
    }

    phrase(buk, last ? '북 · 마지막 발' : `${label} · 북과 박`, bar, 2,
      last ? [[36, 0, 0.25, 0.52]] : [
        [36, 0, 0.22, 0.65], [37, 1.5, 0.12, 0.46], [36, 3, 0.2, 0.57],
        [36, 4, 0.22, 0.65], [37, 5.5, 0.12, 0.43], [36, 7, 0.2, 0.58],
      ], outro ? 0.62 : 1)

    if (!last) {
      const events: Event[] = [
        [38, 0, 0.14, 0.63], [40, 1, 0.09, 0.4], [41, 1.5, 0.17, 0.57], [40, 2.5, 0.09, 0.41], [38, 3, 0.15, 0.62],
        [41, 4, 0.17, 0.58], [39, 5, 0.1, 0.42], [38, 5.5, 0.14, 0.6], [40, 6.5, 0.1, 0.43], [41, 7, 0.17, 0.6],
      ]
      if (turn || hook) events.push([43, 7.5, 0.1, 0.41], [40, 7.75, 0.1, 0.56])
      phrase(janggu, '장구 · 3 + 3 + 2의 맞물림', bar, 2, events, intro ? 0.78 : breath ? 1.1 : outro ? 0.6 : 1)
    }

    if (local === 0 || (hook && turn)) {
      const events: Event[] = [[intro || outro ? 51 : 49, 0, 0.6, 0.52]]
      if (hook) events.push([42, 1.5, 0.15, 0.42], [44, 3.5, 0.12, 0.35], [42, 5.5, 0.15, 0.43], [44, 7.5, 0.12, 0.34])
      phrase(metal, '달무리 · 장면의 테두리', bar, 2, events, outro ? 0.6 : 1)
    }

    const chord = [[57, 60, 64], [62, 66, 69], [55, 59, 62], [57, 60, 64]][variation]
    if (last) {
      phrase(gaya, '가야금 · 달이 남다', bar, 2, [[64, 0, 0.6, 0.56], [60, 1, 0.6, 0.48], [57, 2.5, 1.3, 0.61], [45, 4.5, 1.7, 0.48]], 0.7)
    } else {
      const events: Event[] = []
      for (let b = 0; b < 2; b++) {
        const offset = b * 4
        events.push([chord[0], offset, 0.32, 0.76], [chord[2], offset + 0.25, 0.24, 0.55],
          [chord[1], offset + 1.5, 0.4, 0.68], [chord[2], offset + 2.75, 0.35, 0.65])
        if (hook) events.push([chord[1] + 12, offset + 3.5, 0.3, 0.59])
      }
      phrase(gaya, `${label} · 가야금의 짜임`, bar, 2,
        breath ? events.filter(([, start]) => local === 0 ? start < 4 : start >= 4) : events, outro ? 0.65 : 1)
    }

    if (!last && (!intro || local === 2) && (!breath || local === 0)) {
      const call = CALLS[hook ? (variation + 2) % 4 : variation]
      phrase(daegeum, hook ? '대금 · 함께 걷자는 말' : '대금 · 메기다', bar, 2, call, intro || outro ? 0.8 : 1)
    }
    if (!intro && !last && (!breath || local === 2)) {
      const response = RESPONSES[hook ? (variation + 1) % 4 : variation]
      phrase(haegeum, hook ? '해금 · 함께 걷는 대답' : '해금 · 받다', bar, 2, response, outro ? 0.72 : 1)
    }
    if (hook || (section.kind === 'verse' && bar >= 24 && variation % 2 === 0)) {
      const voicing = [[57, 60, 64, 67], [54, 57, 62, 64], [55, 59, 62, 66], [57, 60, 64, 67]][variation]
      const events: Event[] = []
      for (const start of [1.5, 3.5, 5.5, 7.5]) {
        for (const pitch of voicing) events.push([pitch, start, 0.3, start % 4 === 1.5 ? 0.5 : 0.4])
      }
      phrase(keys, '달빛 · 짧은 화음', bar, 2, events)
    }
  }
  return project
}
