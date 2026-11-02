import { describe, expect, it } from 'vitest'
import { ProjectSession } from '../../core/ProjectSession'
import { createEmptyProject, createTrack, duplicateClip, splitClip, validateProject } from '../../core/project'
import { exportProjectBundle, importProjectBundle, saveProject } from '../../core/storage'
import type { AudioAsset, AudioClip, Project } from '../../core/types'
import { PITCH_LIMITS, type PitchEditDocument } from './model'
import { applyPitchDocument, assertPitchSourceTiming, copyPitchDocument, encodePitchWav, restorePitchSource, validatePitchDocument } from './state'

function document(sourceAssetId = 'original'): PitchEditDocument {
  const analysis: PitchEditDocument['analysis'] = {
    version: 1, algorithm: 'yin-v1', sampleRate: 48000, sourceFrames: 48000,
    notes: [
      { id: 'note-1', start: 0, end: 0.5, midi: 60.2, confidence: 0.93 },
      { id: 'note-2', start: 0.5, end: 1, midi: 64.1, confidence: 0.86 },
    ],
    contour: [
      { time: 0.05, midi: 60.1, confidence: 0.9 },
      { time: 0.35, midi: 60.3, confidence: 0.95 },
      { time: 0.7, midi: 64.1, confidence: 0.87 },
    ],
  }
  return { version: 1, sourceAssetId, sourceHash: 'a'.repeat(64), rendererId: 'test-v1', analysis, segments: analysis.notes.map(note => ({ ...note })), shifts: { 'note-1': -20 } }
}

function originalClip(sourceAssetId = 'original'): AudioClip {
  return { id: 'clip', kind: 'audio', name: '보컬 원본', assetId: sourceAssetId, startBeat: 4, lengthBeats: 2, offsetSeconds: 0, gain: 0.8, fadeIn: 0.01, fadeOut: 0.02 }
}

function projectFor(clip: AudioClip): Project {
  return { ...createEmptyProject(), bpm: 120, tracks: [{ ...createTrack('audio'), id: 'track', clips: [clip] }] }
}

function getClip(project: Project): AudioClip {
  const clip = project.tracks[0].clips[0]
  if (clip.kind !== 'audio') throw new Error('Expected an audio fixture')
  return clip
}

/** Construct corrupt unknown input without weakening the production document type. */
function corrupt(path: string, value: unknown): unknown {
  const input = document()
  const keys = path.split('.')
  let target = input as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
  target[keys.at(-1)!] = value
  return input
}

describe('pitch document validation', () => {
  it('keeps the complete analysis and edits in fresh containers and canonicalizes zero shifts', () => {
    const source = document()
    source.shifts['note-2'] = 0
    const parsed = validatePitchDocument(source)
    expect(parsed).toEqual({ ...source, shifts: { 'note-1': -20 } })
    expect(parsed.analysis).not.toBe(source.analysis)
    expect(parsed.analysis.notes[0]).not.toBe(source.analysis.notes[0])
    expect(parsed.analysis.contour[0]).not.toBe(source.analysis.contour[0])
    expect(parsed.segments[0]).not.toBe(source.segments[0])
    expect(parsed.shifts).not.toBe(source.shifts)
    parsed.segments[0].midi = 72
    parsed.shifts['note-1'] = 100
    expect(source.segments[0].midi).toBe(60.2)
    expect(source.shifts['note-1']).toBe(-20)
  })

  it.each([
    ['unsupported document version', 'version', 2],
    ['unsupported analysis version', 'analysis.version', 2],
    ['unsupported algorithm', 'analysis.algorithm', 'polyphonic'],
    ['empty original reference', 'sourceAssetId', ''],
    ['oversized original reference', 'sourceAssetId', 'x'.repeat(201)],
    ['invalid original hash', 'sourceHash', 'not-a-digest'],
    ['missing renderer ID', 'rendererId', ''],
    ['fractional sample rate', 'analysis.sampleRate', 48000.5],
    ['unsupported sample rate', 'analysis.sampleRate', 7999],
    ['fractional frame count', 'analysis.sourceFrames', 48000.5],
    ['zero frame count', 'analysis.sourceFrames', 0],
    ['excess duration', 'analysis.sourceFrames', 48000 * PITCH_LIMITS.maxDurationSeconds + 1],
    ['non-finite note pitch', 'analysis.notes.0.midi', Number.NaN],
    ['negative note confidence', 'segments.0.confidence', -0.01],
    ['note outside source', 'segments.1.end', 1.1],
    ['reversed note', 'segments.0.end', 0],
    ['overlapping notes', 'segments.0.end', 0.6],
    ['duplicate note ID', 'segments.1.id', 'note-1'],
    ['duplicate analysis ID', 'analysis.notes.1.id', 'note-1'],
    ['unsorted contour', 'analysis.contour.1.time', 0.01],
    ['duplicate contour time', 'analysis.contour.1.time', 0.05],
    ['non-finite contour pitch', 'analysis.contour.0.midi', Infinity],
    ['unknown shift reference', 'shifts', { missing: 100 }],
    ['non-finite shift', 'shifts', { 'note-1': Infinity }],
    ['shift over limit', 'shifts', { 'note-1': PITCH_LIMITS.maxCents + 0.01 }],
    ['shift under limit', 'shifts', { 'note-1': PITCH_LIMITS.minCents - 0.01 }],
  ])('rejects %s', (_name, path, value) => {
    expect(() => validatePitchDocument(corrupt(path as string, value))).toThrow()
  })

  it('rejects excessive or sparse arrays rather than creating incomplete document objects', () => {
    const good = document()
    expect(() => validatePitchDocument(corrupt('segments', Array.from({ length: PITCH_LIMITS.maxNotes + 1 }, () => good.segments[0])))).toThrow()
    expect(() => validatePitchDocument(corrupt('analysis.contour', Array.from({ length: PITCH_LIMITS.maxContourPoints + 1 }, () => good.analysis.contour[0])))).toThrow()
    for (const path of ['analysis.notes', 'analysis.contour', 'segments']) {
      expect(() => validatePitchDocument(corrupt(path, new Array(2)))).toThrow(/비어 있는/)
    }
  })

  it('rejects note and shift keys that could resolve to Object.prototype members', () => {
    for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', '__defineGetter__']) {
      expect(() => validatePitchDocument(corrupt('segments.0.id', id))).toThrow(/식별자/)
      const shifts = JSON.parse(`{"${id}":100}`)
      expect(() => validatePitchDocument(corrupt('shifts', shifts))).toThrow(/식별자/)
    }
    expect(Object.prototype).not.toHaveProperty('note-1')
  })

  it('accepts existing opaque Unicode asset IDs without applying note-key restrictions', () => {
    const source = document('녹음 원본 / 첫 테이크.wav')
    expect(validatePitchDocument(source).sourceAssetId).toBe(source.sourceAssetId)
    expect(validatePitchDocument({ ...source, sourceAssetId: '__proto__' }).sourceAssetId).toBe('__proto__')
  })

  it('permits split segment IDs and boundary pitch shifts while keeping original analysis', () => {
    const source = document()
    source.segments = [
      { ...source.segments[0], id: 'split-left', end: 0.25 },
      { ...source.segments[0], id: 'split-right', start: 0.25 },
      source.segments[1],
    ]
    source.shifts = { 'split-left': -1200, 'split-right': 1200 }
    expect(validatePitchDocument(source)).toEqual(source)
  })
})

describe('pitch source and render binding', () => {
  it('accepts sample-rate conversion that preserves source time and limits rounding to two lower-rate frames', () => {
    const source = document()
    expect(() => assertPitchSourceTiming(source, 96000, 96000)).not.toThrow()
    expect(() => assertPitchSourceTiming(source, 44100, 44100)).not.toThrow()
    expect(() => assertPitchSourceTiming(source, 96000, 96004)).not.toThrow()
    expect(() => assertPitchSourceTiming(source, 96000, 96005)).toThrow(/길이가 다릅니다/)
    expect(() => assertPitchSourceTiming(source, 48000, 24000)).toThrow(/길이가 다릅니다/)
    expect(() => assertPitchSourceTiming(source, 96000, 48000)).toThrow(/길이가 다릅니다/)
    expect(() => assertPitchSourceTiming(source, 48000.5, 48000)).toThrow(/정수/)
    expect(() => assertPitchSourceTiming(source, 48000, Number.NaN)).toThrow()
  })

  it('requires the same immutable source and a distinct valid render for non-zero edits', () => {
    const clip = originalClip()
    expect(() => applyPitchDocument(clip, document('other-source'), 'render')).toThrow(/원본이 변경/)
    expect(() => applyPitchDocument(clip, document(), clip.assetId)).toThrow(/렌더 음원/)
    for (const id of ['', 'x'.repeat(201), undefined, 3]) {
      expect(() => applyPitchDocument(clip, document(), id as string)).toThrow(/식별자/)
    }
    const applied = applyPitchDocument(clip, document(), '피치 렌더 / 1.wav')
    expect(applied.assetId).toBe('피치 렌더 / 1.wav')
    expect(applied.pitch!.sourceAssetId).toBe('original')
    expect(clip).not.toHaveProperty('pitch')
    expect(clip.assetId).toBe('original')
  })

  it('updates from the original source even after applying a derived asset, and restores exactly', () => {
    const original = originalClip()
    const first = applyPitchDocument(original, document(), 'render-1')
    const secondDocument = { ...document(), shifts: { 'note-2': 37.5 } }
    const second = applyPitchDocument(first, secondDocument, 'render-2')
    expect(second.assetId).toBe('render-2')
    expect(second.pitch!.sourceAssetId).toBe('original')
    expect(() => applyPitchDocument(first, document('render-1'), 'render-2')).toThrow(/원본이 변경/)
    expect(restorePitchSource(second)).toEqual(original)
    expect(restorePitchSource(original)).toBe(original)
  })

  it('returns the original audio when all shifts are cleared while preserving segmentation', () => {
    const applied = applyPitchDocument(originalClip(), document(), 'render-1')
    const clean = { ...document(), shifts: { 'note-1': 0 } }
    const next = applyPitchDocument(applied, clean, 'render-2')
    expect(next.assetId).toBe('original')
    expect(next.pitch!.shifts).toEqual({})
    expect(next.pitch!.segments).toEqual(clean.segments)
  })
})

describe('history and independent region edits', () => {
  it('restores audio references and edit metadata through apply, undo, redo, and original reset', () => {
    const session = new ProjectSession(projectFor(originalClip()))
    const original = getClip(session.getSnapshot().history.present)
    const apply = (clip: AudioClip) => session.edit(project => ({ ...project, tracks: project.tracks.map(track => ({ ...track, clips: [clip] })) }))
    const edited = applyPitchDocument(original, document(), 'render-1')
    apply(edited)
    expect(session.getSnapshot().history.past).toHaveLength(1)
    expect(getClip(session.getSnapshot().history.present)).toEqual(edited)
    session.dispatch({ type: 'undo' })
    expect(getClip(session.getSnapshot().history.present)).toEqual(original)
    session.dispatch({ type: 'redo' })
    expect(getClip(session.getSnapshot().history.present)).toEqual(edited)
    apply(restorePitchSource(edited))
    expect(getClip(session.getSnapshot().history.present)).toEqual(original)
    session.dispatch({ type: 'undo' })
    expect(getClip(session.getSnapshot().history.present)).toEqual(edited)
  })

  it('copies editable segmentation and shifts while sharing the immutable analysis', () => {
    const source = document()
    const copy = copyPitchDocument(source)
    expect(copy.analysis).toBe(source.analysis)
    copy.segments[0].end = 0.4
    copy.shifts['note-1'] = 50
    expect(source.segments[0].end).toBe(0.5)
    expect(source.shifts['note-1']).toBe(-20)
  })

  it('duplicates and splits retain source/render assets with independent editable documents', () => {
    const source = applyPitchDocument(originalClip(), document(), 'render-1')
    const duplicate = duplicateClip(source, 8) as AudioClip
    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate.assetId).toBe(source.assetId)
    expect(duplicate.pitch!.sourceAssetId).toBe(source.pitch!.sourceAssetId)
    duplicate.pitch!.shifts['note-1'] = 200
    duplicate.pitch!.segments[0].end = 0.25
    expect(source.pitch!.shifts['note-1']).toBe(-20)
    expect(source.pitch!.segments[0].end).toBe(0.5)

    const [left, right] = splitClip(source, 5, 120) as AudioClip[]
    expect(left).toMatchObject({ id: source.id, startBeat: 4, lengthBeats: 1, offsetSeconds: 0, assetId: 'render-1' })
    expect(right).toMatchObject({ startBeat: 5, lengthBeats: 1, offsetSeconds: 0.5, assetId: 'render-1' })
    expect(right.pitch!.analysis).toBe(left.pitch!.analysis)
    expect(right.pitch!.sourceAssetId).toBe('original')
    right.pitch!.shifts['note-1'] = 100
    right.pitch!.segments[0].end = 0.4
    expect(left.pitch!.shifts['note-1']).toBe(-20)
    expect(left.pitch!.segments[0].end).toBe(0.5)
  })
})

async function bundleFixture() {
  const sourceId = '녹음 원본 / 1.wav', renderId = '피치 렌더 / 1.wav'
  const sourceBlob = encodePitchWav([new Float32Array(48000).fill(0.125)], 48000)
  const renderBlob = encodePitchWav([new Float32Array(48000).fill(-0.25)], 48000)
  const edit = document(sourceId)
  edit.sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await sourceBlob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
  const clip = applyPitchDocument(originalClip(sourceId), edit, renderId)
  const assets = new Map<string, AudioAsset>([
    [sourceId, { id: sourceId, name: '원본.wav', blob: sourceBlob, buffer: {} as AudioBuffer, peaks: [0.125] }],
    [renderId, { id: renderId, name: '수정.wav', blob: renderBlob, buffer: {} as AudioBuffer, peaks: [0.25] }],
  ])
  return { project: projectFor(clip), assets, sourceId, renderId }
}

describe('portable pitch project state', () => {
  it('round-trips original/render bytes, analysis, edits, and schema 3 without encoding runtime buffers', async () => {
    const { project, assets, sourceId, renderId } = await bundleFixture()
    const blob = await exportProjectBundle(project, assets)
    const restored = await importProjectBundle(blob)
    expect(restored.project).toEqual(project)
    expect(restored.project.schemaVersion).toBe(3)
    expect(restored.assets.map(asset => asset.id)).toEqual([sourceId, renderId])
    for (const asset of restored.assets) {
      expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(new Uint8Array(await assets.get(asset.id)!.blob.arrayBuffer()))
    }
    const serialized = JSON.parse(await blob.text())
    expect(serialized.schemaVersion).toBe(1)
    expect(serialized.assets[0]).not.toHaveProperty('buffer')
    expect(serialized.assets[0]).not.toHaveProperty('peaks')
    // This verifies byte preservation and document references, not browser WAV decoding.
  })

  it('rejects missing original audio even when the current render is present', async () => {
    const { project, assets, sourceId, renderId } = await bundleFixture()
    const renderOnly = new Map([[renderId, assets.get(renderId)!]])
    await expect(exportProjectBundle(project, renderOnly)).rejects.toThrow(/original audio file for pitch editing/)
    await expect(saveProject(project, renderOnly)).rejects.toThrow(/original audio file for pitch editing/)
    const bundle = JSON.parse(await (await exportProjectBundle(project, assets)).text())
    bundle.assets = bundle.assets.filter((asset: { id: string }) => asset.id !== sourceId)
    await expect(importProjectBundle(new Blob([JSON.stringify(bundle)]))).rejects.toThrow(/original audio file for pitch editing/)
  })

  it('rejects missing rendered audio and edited projects that point straight at the original', async () => {
    const { project, assets, sourceId } = await bundleFixture()
    await expect(exportProjectBundle(project, new Map([[sourceId, assets.get(sourceId)!]]))).rejects.toThrow(/original audio file/)
    const corruptProject = structuredClone(project)
    getClip(corruptProject).assetId = sourceId
    expect(() => validateProject(corruptProject)).toThrow(/missing its pitch render/)
  })

  it('refuses a derived audio reference that claims to have no pitch changes', () => {
    const clip = applyPitchDocument(originalClip(), document(), 'render-1')
    clip.pitch!.shifts = {}
    expect(() => validateProject(projectFor(clip))).toThrow()
  })

  it('migrates plain schema 1/2 projects and refuses pitch data masquerading as an older schema', () => {
    const source = projectFor(originalClip())
    const v2 = { ...source, schemaVersion: 2 }
    expect(validateProject(v2).schemaVersion).toBe(3)
    const v1 = { ...source, schemaVersion: 1, tracks: source.tracks.map(track => ({ ...track, effects: { filter: 20000, reverb: 0, delay: 0 } })) }
    expect(validateProject(v1).schemaVersion).toBe(3)
    const edited = projectFor(applyPitchDocument(originalClip(), document(), 'render-1'))
    expect(() => validateProject({ ...edited, schemaVersion: 2 })).toThrow(/requires project schema version 3/)
  })
})

describe('portable float PCM rendering', () => {
  it('writes stereo IEEE float WAV with a fact chunk and exact interleaved samples', async () => {
    const left = new Float32Array([0.125, -0.5, 1.25])
    const right = new Float32Array([-0.25, 0.75, -1.5])
    const blob = encodePitchWav([left, right], 48000)
    expect(blob.type).toBe('audio/wav')
    const bytes = await blob.arrayBuffer(), view = new DataView(bytes)
    const text = (start: number) => String.fromCharCode(...new Uint8Array(bytes, start, 4))
    expect(text(0)).toBe('RIFF')
    expect(text(8)).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(text(12)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(3)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(28, true)).toBe(384000)
    expect(view.getUint16(32, true)).toBe(8)
    expect(view.getUint16(34, true)).toBe(32)
    expect(text(36)).toBe('fact')
    expect(view.getUint32(40, true)).toBe(4)
    expect(view.getUint32(44, true)).toBe(3)
    expect(text(48)).toBe('data')
    expect(view.getUint32(52, true)).toBe(24)
    expect(Array.from({ length: 6 }, (_, index) => view.getFloat32(56 + index * 4, true))).toEqual([0.125, -0.25, -0.5, 0.75, 1.25, -1.5])
    expect(left).toEqual(new Float32Array([0.125, -0.5, 1.25]))
  })

  it('rejects invalid channels, rates, lengths, and non-finite PCM without clipping finite floats', () => {
    const samples = new Float32Array([0, 0.1])
    expect(() => encodePitchWav([], 48000)).toThrow()
    expect(() => encodePitchWav([samples, samples, samples], 48000)).toThrow()
    expect(() => encodePitchWav([samples], 48000.5)).toThrow()
    expect(() => encodePitchWav([samples], 7999)).toThrow()
    expect(() => encodePitchWav([new Float32Array()], 48000)).toThrow()
    expect(() => encodePitchWav([samples, new Float32Array(1)], 48000)).toThrow()
    expect(() => encodePitchWav([new Float32Array([Number.NaN])], 48000)).toThrow(/유효하지 않은/)
    expect(() => encodePitchWav([new Float32Array([Infinity])], 48000)).toThrow(/유효하지 않은/)
  })
})
