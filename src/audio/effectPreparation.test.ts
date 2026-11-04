import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareEffects } from './effectPreparation'

const hooks = vi.hoisted(() => ({ first: vi.fn(), second: vi.fn() }))
vi.mock('../devices/effects/registry', () => ({
  EFFECT_MODULES: {
    first: { definition: { name: '앰프' }, prepare: hooks.first },
    second: { definition: { name: '코러스' }, prepare: hooks.second },
    legacy: { definition: { name: '레거시' } },
  },
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

beforeEach(() => {
  hooks.first.mockReset().mockResolvedValue(undefined)
  hooks.second.mockReset().mockResolvedValue(undefined)
})

describe('effect preparation boundary', () => {
  it('waits for every registered effect and shares preparation within one context', async () => {
    const pending = deferred()
    hooks.second.mockReturnValueOnce(pending.promise)
    const context = {} as BaseAudioContext
    const prepared = vi.fn()
    const first = prepareEffects(context)
    const second = prepareEffects(context)
    void first.then(prepared)
    await Promise.resolve()
    expect(prepared).not.toHaveBeenCalled()
    expect(second).toBe(first)
    expect(hooks.first).toHaveBeenCalledExactlyOnceWith(context)
    expect(hooks.second).toHaveBeenCalledExactlyOnceWith(context)
    pending.resolve()
    await first
    await prepareEffects(context)
    expect(hooks.first).toHaveBeenCalledTimes(1)
    expect(prepared).toHaveBeenCalledTimes(1)
  })

  it('registers a new/offline context independently of an already prepared context', async () => {
    const live = {} as BaseAudioContext
    const offline = {} as BaseAudioContext
    await prepareEffects(live)
    await prepareEffects(offline)
    expect(hooks.first.mock.calls.map(([context]) => context)).toEqual([live, offline])
    expect(hooks.second.mock.calls.map(([context]) => context)).toEqual([live, offline])
  })

  it('surfaces the failing effect name and permits an explicit retry', async () => {
    const context = {} as BaseAudioContext
    hooks.first.mockRejectedValueOnce(new Error('processor blocked'))
    await expect(prepareEffects(context)).rejects.toThrow('앰프 오디오 처리를 불러오지 못했습니다: processor blocked')
    await expect(prepareEffects(context)).resolves.toBeUndefined()
    expect(hooks.first).toHaveBeenCalledTimes(2)
  })
})
