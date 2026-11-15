import { describe, expect, it } from 'vitest'
import { deviceView, loadViewGroup, VIEW_GROUPS } from './views'

describe('lazy 시김새 editor registry', () => {
  it.each(Object.keys(VIEW_GROUPS) as (keyof typeof VIEW_GROUPS)[])('lists exactly the %s group views', async group => {
    const { VIEWS } = await loadViewGroup[group]()
    expect(Object.keys(VIEWS).sort()).toEqual([...VIEW_GROUPS[group]].sort())
  })

  it('returns a stable component for graphical types and none for knob-grid types', () => {
    expect(deviceView('eq')).toBeTypeOf('function')
    expect(deviceView('eq')).toBe(deviceView('eq'))
    expect(deviceView('not-an-effect')).toBeUndefined()
  })
})
