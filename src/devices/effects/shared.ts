import type { ParamDef } from '../contracts.js'

export function paramValue(defs: readonly ParamDef[], params: Record<string, number> | undefined, id: string): number {
  const value = params?.[id]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return defs.find(def => def.id === id)?.default ?? 0
}

export function setParameter(parameter: AudioParam, value: number, now: number, smooth: boolean): void {
  parameter.cancelScheduledValues(now)
  if (smooth) parameter.setTargetAtTime(value, now, 0.012)
  else parameter.setValueAtTime(value, now)
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20)

export function randomGenerator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

export const parameterReader = (defs: readonly ParamDef[], params: Record<string, number> | undefined) =>
  (id: string): number => paramValue(defs, params, id)

export const noTail = (): number => 0
