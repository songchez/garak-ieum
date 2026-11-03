import { describe, expect, it } from 'vitest'
import { snapToEdges, type EdgeSnapRequest } from './edgeSnap'

const request = (patch: Partial<EdgeSnapRequest> = {}): EdgeSnapRequest => ({ rawDelta: 1.03, gridDelta: 1, movingEdges: [0, 4], targetEdges: [5.05, 9], ppb: 100, enabled: true, ...patch })

describe('region and note boundary magnetism', () => {
  it('joins an off-grid neighbour exactly instead of leaving a gap from grid quantization', () => {
    const result = snapToEdges(request())
    expect(result.delta).toBeCloseTo(1.05)
    expect(4 + result.delta).toBe(5.05)
    expect(result.guide).toBe(5.05)
  })
  it('joins a copied region or note to its surviving off-grid original', () => {
    const originalEdges = [.03, 4.03]
    const copy = snapToEdges(request({ rawDelta: 3.98, gridDelta: 3.97, movingEdges: originalEdges, targetEdges: originalEdges }))
    expect(originalEdges[0] + copy.delta).toBe(originalEdges[1])
    expect(copy.guide).toBe(originalEdges[1])
    // A normal move removes the original from the layout, so it is not a snap target.
    expect(snapToEdges(request({ rawDelta: 3.98, gridDelta: 3.97, movingEdges: originalEdges, targetEdges: [] }))).toEqual({ delta: 3.97, guide: null })
  })
  it('uses a screen-distance threshold and chooses the nearest edge', () => {
    expect(snapToEdges(request({ rawDelta: .8 })).guide).toBeNull()
    expect(snapToEdges(request({ targetEdges: [5.08, 5.02, 5.05] })).guide).toBe(5.02)
    expect(snapToEdges(request({ rawDelta: .8, ppb: 20 })).guide).toBe(5.05)
  })
  it('bypasses magnetism for snap off and the no-snap gesture', () => {
    expect(snapToEdges(request({ enabled: false, gridDelta: 1.03 }))).toEqual({ delta: 1.03, guide: null })
  })
  it('does not snap outside source/region bounds or change the spacing of a group', () => {
    expect(snapToEdges(request({ maxDelta: 1 })).guide).toBeNull()
    const result = snapToEdges(request({ movingEdges: [0, 2, 3, 4] }))
    expect((3 + result.delta) - (0 + result.delta)).toBe(3)
    expect(snapToEdges(request({ minDelta: 2 })).delta).toBe(2)
  })
  it('finds an exact adjacent edge in a large arrangement without changing other positions', () => {
    const edges = Array.from({ length: 10_000 }, (_, index) => index * .25 + .03)
    const before = [...edges]
    const result = snapToEdges(request({ movingEdges: Array.from({ length: 100 }, (_, index) => index * 4), targetEdges: edges, rawDelta: .28, gridDelta: .25 }))
    expect(result.delta).toBeCloseTo(.28)
    expect(edges).toEqual(before)
  })
})
