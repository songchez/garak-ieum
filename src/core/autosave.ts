import { isKnownValidProject, validateProject } from './project'
import type { Project } from './types'

/**
 * Autosave policy (docs/ARCHITECTURE_REVIEW.md 4.2 #6). A 32-track/66k-note project costs ~18 ms of validateProject and a
 * 7 MB structured clone per IndexedDB put; doing both 650 ms after every edit pause kept the main thread busy.
 *
 * - Debounce: the quiet period grows with the measured duration of the previous save (650 ms for small projects,
 *   up to 4 s for very large ones), so heavy projects write less often during continuous editing.
 * - Validation: internally produced snapshots are not revalidated on every autosave. A snapshot that already passed
 *   validateProject (ProjectSession command results, opened/imported projects) is trusted as is; any other one gets a
 *   cheap structural invariant check, and a full validation at most every FULL_VALIDATION_INTERVAL_MS. Loads and
 *   imports always validate fully, and explicit saves (close, navigation, export) validate fully too.
 * - Crash safety: every full validation also refreshes a "last validated" copy of the project; if the latest autosave
 *   ever fails validation on load, that copy is opened instead (core/storage.ts).
 * - Writes: storage keeps content-addressed meta/track/clip/asset records and writes only the changed ones, so a note
 *   edit writes one clip and one track record instead of the whole project and its audio (core/projectRecords.ts).
 */
export const AUTOSAVE_MIN_DELAY_MS = 650
export const AUTOSAVE_MAX_DELAY_MS = 4000
export const FULL_VALIDATION_INTERVAL_MS = 30_000

/** A pending autosave is never pushed back further than this by later edits (see AutosaveScheduler). */
export const AUTOSAVE_MAX_PENDING_MS = 5000

export function autosaveDelay(lastSaveMs: number): number {
  if (!Number.isFinite(lastSaveMs) || lastSaveMs <= 0) return AUTOSAVE_MIN_DELAY_MS
  return Math.round(Math.min(AUTOSAVE_MAX_DELAY_MS, AUTOSAVE_MIN_DELAY_MS + lastSaveMs * 10))
}

/**
 * The autosave timer. A plain trailing debounce lost work: every change re-armed it, including live arm/monitor flags
 * and each tick of a held control, so a burst of edits (pick a preset, move the mic, stomp a pedal, toggle monitoring)
 * kept the write waiting, and a reload or tab close inside that window reopened the project from before the burst.
 *
 * - `schedule` (re)arms the quiet period, but never past AUTOSAVE_MAX_PENDING_MS after the first unsaved change.
 * - `flush` runs the pending save now: the editor calls it when the page is hidden or unloaded (and on Ctrl+S), so the
 *   IndexedDB write starts before the document goes away instead of after a timer that will never fire.
 */
export class AutosaveScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private job: (() => void) | null = null
  private since: number | null = null
  constructor(private readonly maxPendingMs = AUTOSAVE_MAX_PENDING_MS, private readonly now: () => number = () => performance.now()) {}

  /** Runs `job` after `delay` ms without another schedule call, or at the pending ceiling, whichever comes first. */
  schedule(job: () => void, delay: number): void {
    const now = this.now()
    this.since ??= now
    this.job = job
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.flush() }, Math.max(0, Math.min(delay, this.since + this.maxPendingMs - now)))
  }
  /** Runs the pending job immediately. False when nothing was pending. */
  flush(): boolean {
    const job = this.job
    this.cancel()
    if (!job) return false
    job()
    return true
  }
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null; this.job = null; this.since = null
  }
  get pending(): boolean { return this.job !== null }
}

const fail = (reason: string): never => { throw new Error(`자동 저장할 프로젝트 상태가 올바르지 않습니다: ${reason}`) }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** O(tracks + clips) shape check: never walks notes. Catches a broken snapshot before it replaces the saved one. */
export function assertProjectInvariants(project: Project): void {
  if (!project || typeof project !== 'object') fail('project')
  if (typeof project.id !== 'string' || !project.id) fail('id')
  if (!Number.isInteger(project.schemaVersion)) fail('schemaVersion')
  if (!finite(project.bpm) || project.bpm < 30 || project.bpm > 300) fail('bpm')
  if (!finite(project.lengthBeats) || project.lengthBeats <= 0) fail('lengthBeats')
  const loop = project.loop
  if (!loop || !finite(loop.startBeat) || !finite(loop.endBeat) || loop.endBeat <= loop.startBeat || loop.endBeat > project.lengthBeats) fail('loop')
  if (!project.timeSignature || !Number.isInteger(project.timeSignature.numerator)) fail('timeSignature')
  if (!Array.isArray(project.tracks) || !Array.isArray(project.markers)) fail('tracks')
  const ids = new Set<string>()
  for (const track of project.tracks) {
    if (!track || typeof track.id !== 'string' || !track.id || ids.has(track.id)) fail('track id')
    ids.add(track.id)
    if (track.kind !== 'audio' && track.kind !== 'instrument' && track.kind !== 'return') fail('track kind')
    if (!Array.isArray(track.clips) || !Array.isArray(track.devices)) fail('track content')
    if (!finite(track.volume) || !finite(track.pan)) fail('track mix')
    for (const clip of track.clips) {
      if (!clip || typeof clip.id !== 'string' || ids.has(clip.id)) fail('clip id')
      ids.add(clip.id)
      if (!finite(clip.startBeat) || clip.startBeat < 0 || !finite(clip.lengthBeats) || clip.lengthBeats <= 0) fail('clip position')
      if (clip.kind === 'midi' ? !Array.isArray(clip.notes) : clip.kind !== 'audio') fail('clip kind')
    }
  }
}

/** Per-project time of the last full validation (module state: one autosave stream per project in a tab). */
const lastFullValidation = new Map<string, number>()

export interface AutosaveSnapshot { project: Project; validated: boolean }

/**
 * The snapshot an autosave writes. `trusted` marks an internally produced state (the editor's own session); anything
 * else is fully validated as before. `validated` tells storage to refresh the last-validated recovery copy.
 */
export function autosaveSnapshot(project: Project, trusted: boolean, now = Date.now()): AutosaveSnapshot {
  const due = now - (lastFullValidation.get(project.id) ?? -Infinity) >= FULL_VALIDATION_INTERVAL_MS
  if (!trusted || due) {
    const validated = validateProject(project)
    lastFullValidation.set(project.id, now)
    return { project: validated, validated: true }
  }
  if (!isKnownValidProject(project)) assertProjectInvariants(project)
  return { project, validated: false }
}

/** Tests: forget validation times. */
export function resetAutosaveValidation(): void { lastFullValidation.clear() }
