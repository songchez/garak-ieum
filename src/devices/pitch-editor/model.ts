/** Source times are seconds in the unchanged decoded asset, never project beats. */
export interface PitchPoint {
  time: number
  midi: number
  confidence: number
}

export interface PitchNote {
  id: string
  start: number
  end: number
  midi: number
  confidence: number
}

export interface PitchAnalysis {
  version: 1
  algorithm: 'yin-v1'
  sampleRate: number
  sourceFrames: number
  notes: PitchNote[]
  contour: PitchPoint[]
}

/** Immutable source/analysis plus independent, serializable region edits. */
export interface PitchEditDocument {
  version: 2
  sourceAssetId: string
  sourceHash: string
  rendererId: string
  analysis: PitchAnalysis
  /** User-correctable segmentation; initially a copy of analysis.notes. */
  segments: PitchNote[]
  /** Per-segment pitch delta, in cents. Missing means unchanged. */
  shifts: Record<string, number>
  /** Request approximate original spectral-envelope preservation while changing pitch. */
  preserveFormants: boolean
  /** Independent per-segment formant displacement, in cents. */
  formantShifts: Record<string, number>
}

export const PITCH_LIMITS = {
  maxDurationSeconds: 60,
  maxChannels: 2,
  minSampleRate: 8000,
  maxSampleRate: 192000,
  maxNotes: 4096,
  maxContourPoints: 12000,
  minCents: -1200,
  maxCents: 1200,
  minFormantCents: -1200,
  maxFormantCents: 1200,
  minNoteSeconds: 0.025,
} as const

export interface PitchTaskOptions {
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

export interface PitchRenderSettings {
  preserveFormants: boolean
  formantShifts: Readonly<Record<string, number>>
}

export interface PitchRenderTaskOptions extends PitchTaskOptions {
  settings?: PitchRenderSettings
}

export interface PitchRenderedEdit {
  document: PitchEditDocument
  channels: Float32Array[]
  sampleRate: number
}
