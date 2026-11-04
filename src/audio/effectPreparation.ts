import type { RealtimeEffectModule } from '../devices/contracts'
import { EFFECT_MODULES } from '../devices/effects/registry'

const preparations = new WeakMap<BaseAudioContext, Promise<void>>()

/**
 * Register every built-in processor on the context, including effects not yet in the
 * project. Graph construction stays synchronous when an effect is added during a
 * session. Offline contexts require their own registration before startRendering().
 */
export function prepareEffects(context: BaseAudioContext): Promise<void> {
  const existing = preparations.get(context)
  if (existing) return existing
  const modules: readonly RealtimeEffectModule[] = Object.values(EFFECT_MODULES)
  const preparation = Promise.all(modules.map(async effect => {
    if (!effect.prepare) return
    try { await effect.prepare(context) } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${effect.definition.name} 오디오 처리를 불러오지 못했습니다: ${detail}`, { cause: error })
    }
  })).then(() => undefined).catch(error => {
    // A rejected preparation is visible to the caller and may be explicitly retried.
    if (preparations.get(context) === preparation) preparations.delete(context)
    throw error
  })
  preparations.set(context, preparation)
  return preparation
}
