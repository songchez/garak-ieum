import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { AudioAsset, Project } from '../../core/types'
import type { ProjectSessionSnapshot, SessionAction } from '../../core/ProjectSession'
import { warpRatio, warpRatioSupported } from './state'
import { applyWarpRender, pendingGroups, referencedAssets, type RenderGroup } from './renderPlan'
import { encodeFloatWav } from './wav'
import { stretchInWorker } from './client'

/** Debounce so typing or dragging the tempo renders once. */
export const WARP_RENDER_DELAY_MS = 450
const RENDER_NAME = ' · 워프 '

export interface WarpRendererOptions {
  project: Project
  session: { getSnapshot(): ProjectSessionSnapshot; dispatch(action: SessionAction): void }
  assetsRef: MutableRefObject<Map<string, AudioAsset>>
  /** Install before publishing a project that references the new asset. */
  installAssets: (next: Map<string, AudioAsset>) => void
  decodeAsset: (blob: Blob, name: string) => Promise<AudioAsset>
  /** True while recording, importing, or changing audio settings: renders wait. */
  blocked: () => boolean
  /** Changes when another project opens; results for the old one are dropped. */
  epoch: () => number
  notify: (message: string) => void
}

/**
 * Keeps warped clips' audible assets rendered for the project tempo. Renders are
 * derived data: they are installed with a "live" session change, so they never add an
 * undo step, and every undo/redo state stays self-consistent (asset + renderBpm).
 */
export function useWarpRenderer(options: WarpRendererOptions): { rendering: boolean } {
  const latest = useRef(options)
  latest.current = options
  const [rendering, setRendering] = useState(false)
  const cache = useRef(new Map<string, string>())
  const created = useRef(new Set<string>())
  const failed = useRef(new Set<string>())
  const running = useRef<AbortController | null>(null)
  const runningBpm = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { project } = options

  useEffect(() => {
    const install = (group: RenderGroup, assetId: string) => {
      const { session } = latest.current
      const assets = latest.current.assetsRef.current
      session.dispatch({ type: 'live', edit: current => applyWarpRender(current, group, assetId, assets) })
    }
    const prune = () => {
      const { assetsRef, installAssets, session } = latest.current
      const used = referencedAssets(session.getSnapshot())
      let next: Map<string, AudioAsset> | null = null
      for (const [id, asset] of assetsRef.current) {
        if (used.has(id) || !(created.current.has(id) || asset.name.includes(RENDER_NAME))) continue
        next ??= new Map(assetsRef.current)
        next.delete(id); created.current.delete(id)
      }
      if (!next) return
      for (const [key, id] of cache.current) if (!next.has(id)) cache.current.delete(key)
      installAssets(next)
    }
    /** Same-tempo and cached renders apply at once, without the debounce. */
    const applyImmediate = (groups: RenderGroup[]) => {
      const rest: RenderGroup[] = []
      for (const group of groups) {
        const cached = cache.current.get(group.key)
        if (Math.abs(group.bpm - group.sourceBpm) < 1e-6) install(group, group.originalAssetId)
        else if (cached && latest.current.assetsRef.current.has(cached)) install(group, cached)
        else rest.push(group)
      }
      return rest
    }
    const groups = applyImmediate(pendingGroups(project, latest.current.assetsRef.current)).filter(group => !failed.current.has(group.key))
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    // A tempo change makes an in-flight render for the previous tempo useless.
    if (running.current && runningBpm.current !== project.bpm) { running.current.abort(); running.current = null }
    if (!groups.length || running.current) return
    const start = async () => {
      timer.current = null
      if (latest.current.blocked()) { timer.current = setTimeout(start, 1000); return }
      const controller = new AbortController()
      running.current = controller
      runningBpm.current = latest.current.session.getSnapshot().history.present.bpm
      setRendering(true)
      const epoch = latest.current.epoch()
      try {
        for (;;) {
          const current = latest.current.session.getSnapshot().history.present
          const group = applyImmediate(pendingGroups(current, latest.current.assetsRef.current)).find(item => !failed.current.has(item.key))
          if (!group || controller.signal.aborted) break
          runningBpm.current = group.bpm
          const { assetsRef, decodeAsset } = latest.current
          const source = assetsRef.current.get(group.originalAssetId)
          try {
            if (!source) throw new Error('워프 원본 음원이 없습니다.')
            if (!warpRatioSupported(group.sourceBpm, group.bpm)) throw new Error('원본과 프로젝트의 템포 차이가 너무 큽니다. 워프는 원래 길이의 1/4~4배까지 지원합니다.')
            const channels = await stretchInWorker(source.buffer, warpRatio(group.sourceBpm, group.bpm), { signal: controller.signal })
            const asset = await decodeAsset(encodeFloatWav(channels, source.buffer.sampleRate), `${source.name.replace(/ · 워프 .*$/, '')}${RENDER_NAME}${group.bpm} BPM`)
            if (controller.signal.aborted || latest.current.epoch() !== epoch) break
            const next = new Map(latest.current.assetsRef.current)
            next.set(asset.id, asset)
            latest.current.installAssets(next)
            created.current.add(asset.id)
            cache.current.set(group.key, asset.id)
            install(group, asset.id)
          } catch (error) {
            if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) break
            failed.current.add(group.key)
            latest.current.notify(`워프 렌더에 실패했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`)
          }
        }
      } finally {
        if (running.current === controller) running.current = null
        if (!running.current) setRendering(false)
        if (latest.current.epoch() === epoch) prune()
        // Edits made while rendering may need another pass.
        const left = pendingGroups(latest.current.session.getSnapshot().history.present, latest.current.assetsRef.current).filter(group => !failed.current.has(group.key))
        if (left.length && !timer.current) timer.current = setTimeout(start, WARP_RENDER_DELAY_MS)
      }
    }
    timer.current = setTimeout(start, WARP_RENDER_DELAY_MS)
  }, [project])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); running.current?.abort() }, [])
  return { rendering }
}
