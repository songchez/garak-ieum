import type { Project } from '../types'
import { hits, insert, part, phrase, sectionAt, session, shifted, type Event, type Section } from './shared'

const SECTIONS: readonly Section[] = [
  { name: '문 열기 · 가야금', bar: 0, bars: 4, kind: 'intro' },
  { name: '첫 마당 · Verse A', bar: 4, bars: 8, kind: 'verse' },
  { name: '함께 · Hook', bar: 12, bars: 8, kind: 'hook' },
  { name: '숨 · 장구 응답', bar: 20, bars: 4, kind: 'break' },
  { name: '둘째 마당 · Verse B', bar: 24, bars: 8, kind: 'verse' },
  { name: '다시 함께 · Hook', bar: 32, bars: 4, kind: 'return' },
  { name: '마당을 나서며', bar: 36, bars: 4, kind: 'outro' },
]

// Original two-bar phrases in D minor pentatonic. The spaces are part of the score.
const GAYA: readonly (readonly Event[])[] = [
  [[62, 0, 0.6, 0.82], [65, 0.75, 0.26, 0.58], [69, 1.5, 0.5, 0.74], [67, 2.5, 0.35, 0.61],
    [65, 3.25, 0.35, 0.57], [62, 4.5, 0.65, 0.77], [60, 5.5, 0.4, 0.6], [62, 6.75, 0.8, 0.69]],
  [[62, 0.5, 0.5, 0.74], [65, 1.25, 0.35, 0.6], [67, 2, 0.5, 0.72], [69, 3.5, 0.3, 0.65],
    [72, 4.25, 0.7, 0.8], [69, 5.25, 0.35, 0.61], [65, 6, 0.3, 0.6], [62, 7, 0.6, 0.7]],
  [[69, 0, 0.5, 0.83], [72, 0.75, 0.3, 0.64], [74, 1.5, 0.65, 0.8], [72, 2.75, 0.3, 0.61],
    [69, 3.5, 0.3, 0.67], [67, 4.5, 0.4, 0.68], [65, 5.25, 0.35, 0.64], [62, 6.5, 1, 0.78]],
  [[65, 0, 0.7, 0.77], [62, 1.25, 0.3, 0.6], [60, 2, 0.45, 0.65], [62, 3.5, 0.3, 0.69],
    [67, 4, 0.7, 0.76], [65, 5.25, 0.4, 0.6], [62, 6, 1.25, 0.75]],
]

export function createMadangBoombap(): Project {
  const project = session('마당의 결', 92, 40, SECTIONS)
  const drums = part('kit-lofi', '붐뱁 · 킥 & 스네어', 0.62, 0, { tone: -0.12 })
  insert(drums, 'compressor', { threshold: -19, ratio: 3, attack: 16, release: 130, makeup: 1.5 })
  const hats = part('kit-lofi', '느슨한 하이햇', 0.25, 0.18, { tone: -0.08 })
  const buk = part('samul', '북 · 낮은 걸음', 0.31, -0.08)
  const janggu = part('samul', '장구 · 묻고 받기', 0.23, 0.16)
  const metal = part('samul', '징 & 꽹과리 · 문턱', 0.13, -0.24)
  insert(metal, 'reverb', { amount: 0.13, size: 0.3, tone: 6500 })
  const bass = part('bass', '베이스 · 마당의 중심', 0.5, 0, { tone: -0.32, sub: 0.7, release: 0.11 })
  const lead = part('gayageum', '가야금 · 메기는 선율', 0.48, -0.2, { release: 0.38, tone: 0.05 })
  insert(lead, 'reverb', { amount: 0.13, size: 0.24, tone: 7200 })
  const answer = part('gayageum', '가야금 · 낮은 대답', 0.27, 0.25, { tone: -0.17, release: 0.28 })
  const daegeum = part('daegeum', '대금 · 숨결', 0.24, 0.08, { attack: 0.025, release: 0.33 })
  insert(daegeum, 'reverb', { amount: 0.2, size: 0.36, tone: 6500 })
  const haegeum = part('haegeum', '해금 · 함께 부르는 선', 0.23, -0.08, { attack: 0.03, release: 0.38, tone: -0.12 })
  insert(haegeum, 'reverb', { amount: 0.16, size: 0.29, tone: 5800 })
  project.tracks = [drums, hats, buk, janggu, metal, bass, lead, answer, daegeum, haegeum]

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
    const label = section.name.split(' · ')[0]

    if (!breath && !last && (!intro || local === 2)) {
      const events: Event[] = []
      for (let b = 0; b < 2; b++) {
        const offset = b * 4
        events.push(...shifted(hits(36, b ? [0, 1.75, 2.5] : [0, 2.5], 0.82), offset))
        events.push([38, offset + 1.015, 0.14, 0.75], [38, offset + 3.02, 0.14, 0.83])
        if (hook) events.push([36, offset + 3.5, 0.14, 0.64])
        if (b === 1 && turn) events.push([40, 6.75, 0.09, 0.35], [38, 7.55, 0.12, 0.49])
        else if (variation % 2 === 1) events.push([40, offset + 2.75, 0.09, 0.3])
      }
      phrase(drums, `${label} · 뒤로 앉은 백비트`, bar, 2, events, intro || outro ? 0.78 : 1)
    }

    if (!last && (!intro || local > 0)) {
      const events: Event[] = []
      const step = breath ? 1 : 0.5
      for (let t = 0; t < 8; t += step) {
        if (outro && t >= 4) break
        const offbeat = t % 1 !== 0
        const open = hook && (t === 3.5 || t === 7.5)
        events.push([open ? 46 : 42, t + (offbeat ? 0.055 : 0), open ? 0.2 : 0.08,
          open ? 0.48 : offbeat ? 0.34 + variation * 0.025 : 0.56])
      }
      phrase(hats, breath ? '쉼 · 발끝만' : '흔들리는 여덟 박', bar, 2, events, intro || outro ? 0.7 : 1)
    }

    phrase(buk, last ? '마지막 북' : `${label} · 북`, bar, 2,
      last ? [[36, 0, 0.3, 0.56]] : [
        [36, 0, 0.24, intro ? 0.7 : 0.62], [45, 2.5, 0.2, 0.42], [36, 4, 0.24, 0.66],
        ...(hook || breath ? [[36, 6.5, 0.2, 0.53], [45, 7.25, 0.18, 0.4]] as Event[] : []),
      ], outro ? 0.7 : 1)

    if (!last && (!intro || local === 2)) {
      const events: Event[] = [
        [41, 0, 0.18, 0.57], [40, 1.5, 0.1, 0.44], [38, 3, 0.16, 0.6],
        [41, 4, 0.18, 0.57], [39, 5.5, 0.12, 0.42], [40, 6.75, 0.1, 0.46],
      ]
      if (turn || breath) events.push([38, 7, 0.12, 0.54], [43, 7 + 1 / 3, 0.1, 0.43], [40, 7 + 2 / 3, 0.1, 0.62])
      else if (hook) events.push([38, 7.5, 0.15, 0.56])
      phrase(janggu, turn || breath ? '장구 · 세 박 응답' : '장구 · 사이를 잇다', bar, 2, events, breath ? 1.12 : outro ? 0.65 : 1)
    }

    if (local === 0 || (hook && turn)) {
      const events: Event[] = [[intro || outro ? 51 : 49, 0, 0.6, intro ? 0.43 : 0.56]]
      if (hook) events.push([42, 3.5, 0.2, 0.46], [44, 7, 0.15, 0.37])
      phrase(metal, '징 · 장면 전환', bar, 2, events, outro ? 0.6 : 1)
    }

    if (!last && (!intro || local === 2) && (!breath || local === 2)) {
      const root = [38, 36, 43, 38][variation]
      const fifth = root === 36 ? 43 : root === 43 ? 50 : 45
      const events: Event[] = [
        [root, 0, 1.2, 0.78], [root, 2.5, 0.7, 0.66], [root, 4, 1.3, 0.76],
        [fifth, 5.75, 0.55, 0.59], [root, 7, 0.6, 0.68],
      ]
      if (hook) events.push([root + 12, 3.5, 0.3, 0.52])
      phrase(bass, `${label} · ${['D', 'C', 'G', 'D'][variation]}`, bar, 2, events, outro ? 0.72 : 1)
    }

    if (last) {
      phrase(lead, '끝 · D의 여운', bar, 2, [[65, 0, 0.5, 0.54], [62, 1, 0.8, 0.6], [50, 3, 2.2, 0.52]], 0.75)
    } else if (!breath || local === 0) {
      const motif = GAYA[hook ? 2 + variation % 2 : variation % 2]
      phrase(lead, `${label} · 가야금 ${variation + 1}`, bar, 2,
        breath ? motif.filter(([, start]) => start < 4) : motif, intro ? 1 : outro ? 0.7 : 0.92)
    }

    if ((!intro && !last && variation % 2 === 1) || breath) {
      phrase(answer, breath ? '가야금 · 빈 마당의 대답' : '가야금 · 끝말', bar, 2, [
        [50, 3.25, 0.5, 0.62], [57, 4.75, 0.3, 0.49], [55, 5.5, 0.35, 0.55], [50, 6.75, 0.85, 0.67],
      ], hook ? 0.85 : 1)
    }

    if ((intro && local === 2) || (hook && variation % 2 === 0) || (breath && local === 2) || (section.kind === 'verse' && turn)) {
      phrase(daegeum, '대금 · 한숨의 길이', bar, 2, [
        [74, 2, 1.15, 0.62], [72, 3.5, 0.6, 0.54], [69, 5, 1.4, 0.65], [67, 7, 0.7, 0.52],
      ], intro || breath ? 1 : 0.85)
    }
    if ((hook && variation % 2 === 1) || (section.kind === 'verse' && bar >= 24 && local === 2)) {
      phrase(haegeum, '해금 · 가야금에 답하다', bar, 2, [
        [62, 0.5, 1.3, 0.6], [65, 2.25, 1.1, 0.64], [67, 4.25, 1.2, 0.68], [65, 6, 0.65, 0.58], [62, 7, 0.7, 0.56],
      ])
    }
  }
  return project
}
