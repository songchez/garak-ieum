import { paramValue } from '../core/devices'
import { instrumentDef } from '../core/instruments'
import { isTrackEnabled } from '../core/playback'
import { isReturnTrack, sendsOf } from '../core/sends'
import { tempoMapOf } from '../core/tempoMap'
import { isEffectDevice, type Project } from '../core/types'
import { EFFECT_MODULES } from '../devices/effects/registry'
import { isVintageInstrument, vintageTailSeconds } from '../devices/vintage/params'
import { clamp } from './math'

/**
 * Export tail estimates (docs/BOUNCE_FREEZE_STEMS.md): how long a render keeps going after the arrangement
 * so instrument releases and effect tails ring out. The engine renders what is there; these only size the
 * render (stems share one tail) and record a frozen track's own tail.
 */

/** Own tails of the enabled tracks (instrument release plus insert tails; a frozen track's stored tail). */
function trackTails(project: Project): Map<string, number> {
  const tails = new Map<string, number>()
  // Synced delays ring longest at the slowest tempo of the map.
  const slowest = Math.min(...tempoMapOf(project).points.map(point => point.bpm))
  for (const track of project.tracks) {
    if (!isTrackEnabled(track)) continue
    let tail = 0
    if (track.render?.frozen) { tails.set(track.id, track.render.frozen.tailSeconds); continue }
    const def = instrumentDef(track.instrument)
    if (track.kind === 'instrument' && isVintageInstrument(track.instrument)) {
      tail = Math.max(tail, vintageTailSeconds(track.instrument, track.instrumentParams) + 0.2)
    } else if (track.kind === 'instrument' && !def.isKit) {
      tail = Math.max(tail, clamp(paramValue(def.params, track.instrumentParams, 'release'), 0, 30) + 0.2)
    } else if (track.kind === 'instrument' && def.kind === 'sampled') tail = Math.max(tail, 2)
    for (const device of track.devices) {
      if (!device.enabled || !isEffectDevice(device)) continue
      tail = Math.max(tail, EFFECT_MODULES[device.type].tailSeconds(device.params, slowest))
    }
    tails.set(track.id, tail)
  }
  return tails
}

/** The longest own tail of a non-return track: what a frozen render of that track stores (docs/BOUNCE_FREEZE_STEMS.md). */
export function trackTailSeconds(project: Project): number {
  const tails = trackTails(project)
  return Math.max(0, ...project.tracks.filter(track => !isReturnTrack(track)).map(track => tails.get(track.id) ?? 0))
}

export function renderTailSeconds(project: Project): number {
  const tails = trackTails(project)
  let result = 0.85
  for (const track of project.tracks) {
    const own = tails.get(track.id)
    if (own === undefined) continue
    // A return keeps ringing after its senders' own tails: its effect tail continues from theirs.
    const senders = isReturnTrack(track) ? project.tracks.filter(item => sendsOf(item).some(send => send.returnId === track.id)).map(item => tails.get(item.id) ?? 0) : []
    result = Math.max(result, isReturnTrack(track) ? own + Math.max(0, ...senders) : own)
  }
  return result
}
