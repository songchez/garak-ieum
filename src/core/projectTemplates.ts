import type { Project } from './types'
import { createMadangBoombap } from './projectTemplates/boombap'
import { createHeukryuTrap } from './projectTemplates/trap'
import { createDalbitFusion } from './projectTemplates/fusion'

export interface ProjectTemplate {
  id: string
  name: string
  genre: string
  description: string
  bpm: number
  bars: number
  keyLabel: string
  instruments: readonly string[]
  accent: string
  /** Pure score factory: new editing IDs and objects on every call; no audio or storage. */
  create(): Project
}

/** Original, fully editable arrangements. Research and arrangement notes: docs/SAMPLE_PROJECTS.md. */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'madang-boombap', name: '마당의 결', genre: '국악 붐뱁',
    description: '느슨한 붐뱁 위로 가야금이 말을 걸고, 북과 장구가 대답합니다. 두 번의 마당과 숨 고르기가 있는 40마디.',
    bpm: 92, bars: 40, keyLabel: 'D minor pentatonic',
    instruments: ['가야금', '대금', '해금', '북 · 장구', '로파이 드럼', '베이스'],
    accent: '#DF5435', create: createMadangBoombap,
  },
  {
    id: 'heukryu-trap', name: '검은 물결', genre: '국악 트랩',
    description: '짧게 뜯는 가야금, 묵직한 서브 베이스, 하프타임 클랩과 하이햇 롤. 48마디를 따라 너울이 커집니다.',
    bpm: 144, bars: 48, keyLabel: 'F♯ minor',
    instruments: ['가야금', '대금', '해금', '북 · 장구', '808 드럼', '서브 베이스'],
    accent: '#285973', create: createHeukryuTrap,
  },
  {
    id: 'dalbit-fusion', name: '달빛 행렬', genre: '퓨전 국악',
    description: '두 베이스가 엇박으로 맞물리고 대금과 해금이 선율을 주고받는, 사물 타악과 밴드의 40마디 행렬.',
    bpm: 118, bars: 40, keyLabel: 'A Dorian',
    instruments: ['대금', '해금', '가야금', '사물 타악', '두 베이스', '어쿠스틱 드럼'],
    accent: '#3D7865', create: createDalbitFusion,
  },
]

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find(template => template.id === id)
}

export function createTemplateProject(id: string): Project {
  const template = getProjectTemplate(id)
  if (!template) throw new Error(`Unknown project template: ${id}`)
  return template.create()
}
