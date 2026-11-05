/** Per-track physical inputs: chooser labels, re-finding saved inputs on other hardware (Cubase "Missing
 * Ports"), and the one-edit remap. All pure; see docs/AUDIO_CORE_PLAN.md item 7–8. */
import type { InputChoice, Project, Track, TrackInput } from './types'

export const DEFAULT_INPUT_LABEL = '기본 입력'

export const sameChannels = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((channel, index) => channel === b[index])
export const sameTrackInput = (a: TrackInput | undefined, b: TrackInput | undefined): boolean =>
  a === b || (!!a && !!b && a.label === b.label && sameChannels(a.channels, b.channels))
/** Stable `<select>` value; '' stands for the engine default. */
export const inputKey = (input: Pick<TrackInput, 'channels'> | undefined): string => input ? input.channels.join('+') : ''
export const inputFromChoice = (choice: InputChoice): TrackInput => ({ channels: [...choice.channels] as TrackInput['channels'], label: choice.label })
/** Human channel numbers (1-based), used when a saved input has no name. */
export const channelText = (channels: readonly number[]): string => `입력 ${channels.map(channel => channel + 1).join('/')}`
export const inputText = (input: TrackInput | undefined): string => input ? input.label ?? channelText(input.channels) : DEFAULT_INPUT_LABEL

/** Browser inputs have no names: mono per channel, then adjacent pairs, from the live stream's channel count. */
export function numberedInputChoices(channelCount: number): InputChoice[] {
  const count = Math.max(0, Math.min(32, Math.floor(channelCount)))
  const mono: InputChoice[] = Array.from({ length: count }, (_, index) => ({ channels: [index], label: channelText([index]) }))
  const pairs: InputChoice[] = []
  for (let index = 0; index + 1 < count; index += 2) pairs.push({ channels: [index, index + 1], label: channelText([index, index + 1]) })
  return [...mono, ...pairs]
}

export interface InputRemapPlan {
  /** Saved inputs found again by channel name, usually at another channel number. */
  relinked: { trackId: string; input: TrackInput }[]
  /** Neither the channels nor the name exist; the engine records silence until remapped. */
  missing: string[]
}

/**
 * Compares saved track inputs with the inputs the current device offers. A name match wins over a channel
 * match (the interface moved the named jack); a channel match with a different name keeps the track as it
 * is (the channel was renamed). Without any choices the engine cannot tell, so nothing is reported.
 */
export function planInputRemap(project: Project, choices: readonly InputChoice[]): InputRemapPlan {
  const plan: InputRemapPlan = { relinked: [], missing: [] }
  if (!choices.length) return plan
  for (const track of project.tracks) {
    const input = track.kind === 'audio' ? track.input : undefined
    if (!input) continue
    const byChannels = choices.find(choice => sameChannels(choice.channels, input.channels))
    if (byChannels && (input.label === undefined || byChannels.label === input.label)) continue
    const named = input.label === undefined ? [] : choices.filter(choice => choice.label === input.label)
    const byLabel = named.find(choice => choice.channels.length === input.channels.length) ?? named[0]
    if (byLabel) plan.relinked.push({ trackId: track.id, input: inputFromChoice(byLabel) })
    else if (!byChannels) plan.missing.push(track.id)
  }
  return plan
}

/** One project edit for any number of input changes; null returns the track to the default input. */
export function applyTrackInputs(project: Project, updates: readonly { trackId: string; input: TrackInput | null }[]): Project {
  const byTrack = new Map(updates.map(update => [update.trackId, update.input]))
  let changed = false
  const tracks = project.tracks.map((track): Track => {
    if (track.kind !== 'audio' || !byTrack.has(track.id)) return track
    const input = byTrack.get(track.id) ?? undefined
    if (sameTrackInput(track.input, input)) return track
    changed = true
    const { input: _previous, ...rest } = track
    return input ? { ...rest, input: { channels: [...input.channels] as TrackInput['channels'], ...(input.label === undefined ? {} : { label: input.label }) } } : rest
  })
  return changed ? { ...project, tracks } : project
}
