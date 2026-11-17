import { describe, expect, it } from 'vitest'
import { createDevice, createEmptyProject, createTrack } from './project'
import { NORMALIZE_PEAK, applyBounce, freezeRenderProject, planBounce, planStems, safeFileStem, stemFileName, stemStartFrame, uniqueNames, type StemOptions } from './renderPlan'
import { setTempoAt, tempoMapOf } from './tempoMap'
import { compileNativeTimeline } from '../audio/native/timeline'
import { crc32, createZip } from './zip'
import { encodeWav, peakOf, rightChannelSilent } from '../audio/wavEncode'
import type { AudioClip, MidiClip, Project, Track } from './types'

const midi = (id: string, startBeat = 0, lengthBeats = 4, patch: Partial<MidiClip> = {}): MidiClip => ({
  id, kind: 'midi', name: id, startBeat, lengthBeats, gain: 1, notes: [{ id: `${id}-n`, start: 0, duration: 1, pitch: 60, velocity: 0.8 }], ...patch,
})
const track = (id: string, kind: Track['kind'] = 'instrument', patch: Partial<Track> = {}): Track => ({ ...createTrack(kind, 'keys'), id, name: id, ...patch })
const project = (tracks: Track[], patch: Partial<Project> = {}): Project => ({
  ...createEmptyProject(), id: 'p', name: 'Song', bpm: 120, sampleRate: 48000, lengthBeats: 32, masterVolume: 0.8, loop: { enabled: true, startBeat: 4, endBeat: 8 }, tracks, ...patch,
})
const delay = () => ({ ...createDevice('delay', {}), id: 'dly' })

describe('freeze render plan', () => {
  it('renders the track alone, pre-fader, without sends or mixing lanes, from the whole project', () => {
    const p = project([track('keys', 'instrument', { clips: [midi('a')], volume: 0.3, pan: -0.5, mute: true, solo: true, devices: [delay()], sends: [{ returnId: 'ret', level: 1 }],
      automation: [{ id: 'v', target: { kind: 'track', param: 'volume' }, points: [] }, { id: 'f', target: { kind: 'device', deviceId: 'dly', param: 'feedback' }, points: [] }] }), track('other'), track('ret', 'return')])
    const plan = freezeRenderProject(p, 'keys')
    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0]).toMatchObject({ id: 'keys', volume: 1, pan: 0, mute: false, solo: false, render: { preFader: true } })
    expect(plan.tracks[0].sends).toBeUndefined()
    expect(plan.tracks[0].automation?.map(lane => lane.id)).toEqual(['f'])
    expect(plan).toMatchObject({ lengthBeats: 32, masterVolume: 1, loop: { enabled: false } })
    expect(() => freezeRenderProject(p, 'ret')).toThrow(/리턴/)
    // The native timeline carries the pre-fader tap.
    expect(compileNativeTimeline(plan).tracks[0]).toMatchObject({ preFader: true })
  })
})

describe('bounce in place', () => {
  const source = () => project([track('keys', 'instrument', { clips: [midi('a', 4, 4), midi('b', 12, 4), midi('m', 20, 4, { mute: true })], devices: [delay()], volume: 0.7, pan: 0.2,
    sends: [{ returnId: 'ret', level: 0.5 }], automation: [{ id: 'v', target: { kind: 'track', param: 'volume' }, points: [{ beat: 0, value: 0.5 }] }] }), track('ret', 'return')])

  it('plans a whole track from its first to its last unmuted region, aligned through the tempo map', () => {
    const p = setTempoAt(source(), 8, 60)
    const plan = planBounce(p, 'keys', null, { includeEffects: true, tailSeconds: 3, normalize: false })
    expect(plan).toMatchObject({ startBeat: 4, endBeat: 16, tailSeconds: 3, clipIds: ['a', 'b'] })
    expect(plan.startFrame).toBe(Math.round(tempoMapOf(p).frameAt(4, 48000)))
    expect(plan.project.tracks[0].clips.map(clip => clip.id)).toEqual(['a', 'b'])
    expect(plan.project.lengthBeats).toBe(16)
    expect(plan.project.tracks[0].devices).toHaveLength(1)
    expect(plan.project.tracks[0].render).toEqual({ preFader: true })
  })

  it('bounces selected regions dry when 시김새 is excluded, and refuses returns or empty selections', () => {
    const dry = planBounce(source(), 'keys', ['b'], { includeEffects: false, tailSeconds: 99, normalize: false })
    expect(dry).toMatchObject({ startBeat: 12, endBeat: 16, tailSeconds: 30 })
    expect(dry.project.tracks[0].devices).toEqual([])
    expect(() => planBounce(source(), 'keys', ['m'], { includeEffects: true, tailSeconds: 1, normalize: false })).toThrow(/뮤트된 리전/)
    expect(() => planBounce(source(), 'ret', null, { includeEffects: true, tailSeconds: 1, normalize: false })).toThrow(/리턴/)
  })

  it('places the render on a new audio track and mutes the original (track) or the bounced regions', () => {
    const p = source()
    const options = { includeEffects: false, tailSeconds: 2, normalize: true }
    const plan = planBounce(p, 'keys', null, options)
    const result = applyBounce(p, plan, { id: 'bounce', name: 'Keys 바운스', seconds: 8, peak: 0.5 }, options, true)
    const [original, bounced] = result.project.tracks
    expect(original.mute).toBe(true)
    expect(bounced).toMatchObject({ id: result.trackId, kind: 'audio', volume: 0.7, pan: 0.2, sends: [{ returnId: 'ret', level: 0.5 }] })
    expect(bounced.devices.map(device => device.type)).toEqual(['delay'])
    expect(bounced.devices[0].id).not.toBe('dly')
    expect(bounced.automation?.[0]).toMatchObject({ target: { kind: 'track', param: 'volume' } })
    const clip = bounced.clips[0] as AudioClip
    expect(clip).toMatchObject({ id: result.clipId, assetId: 'bounce', startBeat: 4, offsetSeconds: 0, fadeIn: 0, fadeOut: 0 })
    expect(clip.lengthBeats).toBeCloseTo(16) // 8 s at 120 BPM
    expect(clip.gain).toBeCloseTo(NORMALIZE_PEAK / 0.5)
    // Region bounce: the original track stays audible, only the bounced regions are muted. The clip never passes the project end.
    const regions = planBounce(p, 'keys', ['b'], { includeEffects: true, tailSeconds: 2, normalize: false })
    const after = applyBounce(p, regions, { id: 'r', name: 'r', seconds: 60, peak: 1 }, { includeEffects: true, tailSeconds: 2, normalize: false }, false)
    expect(after.project.tracks[0].mute).toBe(false)
    expect(after.project.tracks[0].clips.map(clip => !!clip.mute)).toEqual([false, true, true])
    expect(after.project.tracks[1].devices).toEqual([])
    expect(after.project.tracks[1].clips[0].startBeat + after.project.tracks[1].clips[0].lengthBeats).toBeCloseTo(32)
    expect(after.project.tracks[1].clips[0].gain).toBe(1)
  })
})

describe('stem export plan', () => {
  const options = (patch: Partial<StemOptions> = {}): StemOptions => ({ tracks: true, returns: true, master: 'pre', startBeat: 0, sampleRate: 48000, bitDepth: 24, pattern: '{n} {track}', ...patch })
  const mix = () => project([
    track('Keys', 'instrument', { clips: [midi('a')], sends: [{ returnId: 'Verb', level: 0.5 }, { returnId: 'Echo', level: 0.2, pre: true }] }),
    track('Bass', 'instrument', { clips: [midi('b')], mute: true }),
    track('Vox', 'audio', { sends: [{ returnId: 'Verb', level: 1 }] }),
    track('Verb', 'return'), track('Echo', 'return'),
  ])

  it('renders each audible track without its sends and each return from every sender kept out of the master', () => {
    const plan = planStems(mix(), options())
    expect(plan.stems.map(stem => `${stem.kind}:${stem.trackId}:${stem.fileName}`)).toEqual(['track:Keys:01 Keys.wav', 'track:Vox:02 Vox.wav', 'return:Verb:03 Verb.wav', 'return:Echo:04 Echo.wav'])
    expect(plan.skipped).toEqual([{ trackId: 'Bass', name: 'Bass', reason: '뮤트됨' }])
    const keys = plan.stems[0].project
    expect(keys.tracks.map(item => item.id)).toEqual(['Keys'])
    expect(keys.tracks[0].sends).toBeUndefined()
    expect(keys).toMatchObject({ masterVolume: 1, loop: { enabled: false } })
    const verb = plan.stems[2].project
    expect(verb.tracks.map(item => item.id)).toEqual(['Keys', 'Bass', 'Vox', 'Verb'])
    expect(verb.tracks.slice(0, 3).every(item => item.render?.directOut === false)).toBe(true)
    expect(verb.tracks[1].mute).toBe(true)
    expect(verb.tracks[3].render).toBeUndefined()
    // The native timeline keeps the senders out of the master sum.
    expect(compileNativeTimeline(verb).tracks.map(item => item.directOut)).toEqual([false, false, false, undefined])
  })

  it('resolves solo once, keeps post-master volume and overrides the rate', () => {
    const soloed = { ...mix(), tracks: mix().tracks.map(item => item.id === 'Vox' ? { ...item, solo: true } : item) }
    const plan = planStems(soloed, options({ master: 'post', sampleRate: 96000, returns: false }))
    expect(plan.stems.map(stem => stem.trackId)).toEqual(['Vox'])
    expect(plan.skipped.map(item => `${item.trackId}:${item.reason}`)).toEqual(['Keys:솔로에서 제외됨', 'Bass:뮤트됨'])
    expect(plan.stems[0].project).toMatchObject({ masterVolume: 0.8, sampleRate: 96000 })
    expect(plan.stems[0].project.tracks[0]).toMatchObject({ solo: false, mute: false })
    expect(stemStartFrame(soloed, 4, 96000)).toBe(192000)
    expect(stemStartFrame(soloed, 999, 48000)).toBe(768000)
  })

  it('names files from the pattern, safely and uniquely', () => {
    expect(stemFileName('{project}_{type}_{n}_{track}', { index: 3, total: 12, track: 'Lead/Vox?', project: 'Song', kind: 'return' })).toBe('Song_return_03_Lead_Vox_')
    expect(stemFileName('', { index: 1, total: 100, track: 'Pad', project: 'Song', kind: 'track' })).toBe('001 Pad')
    expect(safeFileStem('con')).toBe('_con')
    expect(safeFileStem('  ...  ')).toBe('_stem')
    expect(uniqueNames(['Drums', 'drums', 'Drums'], 'wav')).toEqual(['Drums.wav', 'drums (2).wav', 'Drums (3).wav'])
    expect(planStems({ ...mix(), tracks: [track('A', 'audio'), track('A', 'audio', { id: 'A2' })] }, options({ pattern: '{track}' })).stems.map(stem => stem.fileName)).toEqual(['A.wav', 'A (2).wav'])
  })
})

describe('stem files', () => {
  it('writes a stored ZIP with CRC-32 and UTF-8 names', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const data = new Uint8Array([1, 2, 3, 4])
    const zip = new Uint8Array(await createZip([{ name: '01 건반.wav', data }, { name: 'b.wav', data: new Uint8Array(0) }], new Date(2026, 0, 2, 3, 4, 6)).arrayBuffer())
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(view.getUint32(14, true)).toBe(crc32(data))
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)
    const name = new TextEncoder().encode('01 건반.wav')
    expect(new TextDecoder().decode(zip.subarray(30, 30 + name.length))).toBe('01 건반.wav')
  })

  it('encodes 24-bit and float WAV and detects mono pre-fader renders', async () => {
    const left = new Float32Array([0, 0.5, -1, 2]), right = new Float32Array(4)
    const wav = new DataView(await encodeWav([left, right], 48000, 24).arrayBuffer())
    expect(wav.getUint16(34, true)).toBe(24)
    expect(wav.getUint32(40, true)).toBe(4 * 2 * 3)
    expect(wav.getUint8(44 + 12 + 2)).toBe(0x80) // frame 2, left: -1 → 0x800000
    const float = new DataView(await encodeWav([left], 44100, 32).arrayBuffer())
    expect(float.getUint16(20, true)).toBe(3)
    const buffer = (channels: Float32Array[]) => ({ numberOfChannels: channels.length, getChannelData: (index: number) => channels[index] })
    expect(rightChannelSilent(buffer([left, right]))).toBe(true)
    expect(rightChannelSilent(buffer([left, left]))).toBe(false)
    expect(peakOf(buffer([left, right]))).toBe(2)
  })
})
