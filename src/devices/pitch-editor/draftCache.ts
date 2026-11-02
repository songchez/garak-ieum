import type { AudioClip, Clip } from '../../core/types'
import type { PitchEditDocument } from './model'
import { scopeSegments } from './uiEditing'

export interface PitchDraftSnapshot { document: PitchEditDocument | null; dirty: boolean }
export interface CachedPitchDraft {
  base: PitchEditDocument | undefined
  sourceId: string
  offset: number
  length: number
  bpm: number
  name: string
  snapshot: PitchDraftSnapshot
  past: PitchDraftSnapshot[]
  future: PitchDraftSnapshot[]
  selection: string[]
}

/** Session-only drafts are shared by editor instances, not serialized with a project. */
export const pitchDrafts = new Map<string, CachedPitchDraft>()
let projectId: string | null = null
export const pitchDraftProjectId = () => projectId
export const firstPitchDraftId = (currentProjectId: string): string | undefined => projectId === currentProjectId ? pitchDrafts.keys().next().value : undefined

/** Trim and tempo only change the viewport; documents and their history use source seconds. */
export function matchesPitchDraft(cached: CachedPitchDraft, clip: AudioClip, _bpm: number): boolean {
  return cached.base === clip.pitch && cached.sourceId === (clip.pitch?.sourceAssetId ?? clip.assetId)
}

export function pitchDraftConflictMessage(cached: CachedPitchDraft, clip: AudioClip): string {
  return cached.sourceId !== (clip.pitch?.sourceAssetId ?? clip.assetId)
    ? `“${clip.name}” 리전의 원본 음원이 바뀌어 이전 미적용 피치 편집을 초기화했습니다.`
    : `“${clip.name}” 리전의 적용된 피치 상태가 바뀌어 이전 미적용 피치 편집을 초기화했습니다. 현재 적용된 상태를 확인해 주세요.`
}

/** Scope on restore, including local Undo/Redo, without rewriting source-time history. */
export function scopePitchSnapshot(snapshot: PitchDraftSnapshot, start: number, end: number, makeId: () => string): PitchDraftSnapshot {
  if (!snapshot.document) return snapshot
  const document = scopeSegments(snapshot.document, start, end, makeId)
  return document === snapshot.document ? snapshot : { ...snapshot, document }
}

export function enterPitchDraftProject(nextProjectId: string): void {
  if (projectId !== nextProjectId) { pitchDrafts.clear(); projectId = nextProjectId }
}

/** Also call from the host while the lazy editor is unmounted (delete/Undo/import). */
export function reconcilePitchDrafts(nextProjectId: string, clips: readonly Clip[], bpm: number, onConflict?: (message: string) => void): boolean {
  enterPitchDraftProject(nextProjectId)
  const byId = new Map(clips.map(clip => [clip.id, clip]))
  for (const [id, draft] of pitchDrafts) {
    const clip = byId.get(id)
    if (!clip || clip.kind !== 'audio') pitchDrafts.delete(id)
    else if (!matchesPitchDraft(draft, clip, bpm)) {
      pitchDrafts.delete(id)
      onConflict?.(pitchDraftConflictMessage(draft, clip))
    }
  }
  return pitchDrafts.size > 0
}
