import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseManifest, pickZone } from '../audio/samples'
import { instrumentDef } from './instruments'
import { validateProject } from './project'
import { createTemplateProject, getProjectTemplate, PROJECT_TEMPLATES } from './projectTemplates'
import type { MidiClip, Project, Track } from './types'

const midi = (track: Track): MidiClip[] => track.clips.filter((clip): clip is MidiClip => clip.kind === 'midi')
const notes = (track: Track) => midi(track).flatMap(clip => clip.notes)
const musicalContent = (project: Project): unknown => JSON.parse(JSON.stringify(project, (key, value: unknown) => key === 'id' ? undefined : value))
const ids = (project: Project): string[] => [
  project.id, ...project.markers.map(marker => marker.id),
  ...project.tracks.flatMap(track => [track.id, ...track.devices.map(device => device.id),
    ...midi(track).flatMap(clip => [clip.id, ...clip.notes.map(note => note.id)])]),
]
const signature = (clip: MidiClip): string => JSON.stringify(clip.notes.map(({ pitch, start, duration, velocity }) => [pitch, start, duration, velocity]))

describe('editable sample project catalog', () => {
  it('has three distinct styles and rejects an unknown template instead of opening the wrong song', () => {
    expect(PROJECT_TEMPLATES).toHaveLength(3)
    expect(new Set(PROJECT_TEMPLATES.map(template => template.id)).size).toBe(3)
    expect(new Set(PROJECT_TEMPLATES.map(template => template.genre)).size).toBe(3)
    expect(getProjectTemplate('missing')).toBeUndefined()
    expect(() => createTemplateProject('missing')).toThrow(/Unknown project template/)
    for (const template of PROJECT_TEMPLATES) expect(getProjectTemplate(template.id)).toBe(template)
  })

  for (const template of PROJECT_TEMPLATES) {
    describe(template.name, () => {
      it('creates a valid self-contained score whose metadata describes its actual arrangement', () => {
        const project = createTemplateProject(template.id)
        expect(validateProject(project)).toEqual(project)
        expect(project.name).toBe(template.name)
        expect(project.bpm).toBe(template.bpm)
        expect(project.lengthBeats).toBe(template.bars * 4)
        expect(project.sampleRate).toBe(48000)
        expect(project.tracks.length).toBeGreaterThanOrEqual(8)
        expect(project.tracks.length).toBeLessThanOrEqual(12)
        expect(project.loop.enabled).toBe(false)
        expect(project.loop.endBeat - project.loop.startBeat).toBe(32)
        expect(project.tracks.every(track => track.enabled && !track.mute && !track.solo && !track.armed && !track.monitor)).toBe(true)
        expect(project.tracks.every(track => track.clips.length && track.clips.every(clip => clip.kind === 'midi'))).toBe(true)
        expect(project.tracks.flatMap(track => track.devices).length).toBeGreaterThan(4)
      })

      it('gives each opening new object IDs while preserving the authored music', () => {
        const a = template.create()
        const b = template.create()
        const allIds = [...ids(a), ...ids(b)]
        expect(new Set(allIds).size).toBe(allIds.length)
        expect(musicalContent(a)).toEqual(musicalContent(b))
        const originalPitch = midi(b.tracks[0])[0].notes[0].pitch
        midi(a.tracks[0])[0].notes[0].pitch = 1
        a.tracks[0].instrumentParams.level = 0
        a.markers[0].name = 'Changed'
        expect(midi(b.tracks[0])[0].notes[0].pitch).toBe(originalPitch)
        expect(b.tracks[0].instrumentParams.level).toBeGreaterThan(0)
        expect(b.markers[0].name).not.toBe('Changed')
      })

      it('keeps regions within section boundaries and every note within its editable region', () => {
        const project = template.create()
        expect(project.markers.length).toBeGreaterThanOrEqual(6)
        expect(project.markers[0].startBeat).toBe(0)
        const boundaries = [...project.markers.map(marker => marker.startBeat), project.lengthBeats]
        expect([...new Set(boundaries)].sort((a, b) => a - b)).toEqual(boundaries)
        for (const track of project.tracks) {
          let previousEnd = 0
          for (const clip of midi(track)) {
            expect(clip.startBeat).toBeGreaterThanOrEqual(previousEnd)
            const end = clip.startBeat + clip.lengthBeats
            expect(end).toBeLessThanOrEqual(project.lengthBeats)
            const nextSection = boundaries.find(beat => beat > clip.startBeat)!
            expect(end).toBeLessThanOrEqual(nextSection)
            expect(clip.loop).not.toBe(true)
            expect(clip.notes.length).toBeGreaterThan(0)
            for (const note of clip.notes) {
              expect(note.start).toBeGreaterThanOrEqual(0)
              expect(note.duration).toBeGreaterThan(0)
              expect(note.start + note.duration).toBeLessThanOrEqual(clip.lengthBeats + 1e-9)
              expect(note.velocity).toBeGreaterThan(0)
              expect(note.velocity).toBeLessThanOrEqual(1)
            }
            previousEnd = end
          }
        }
      })

      it('uses real sample zones and bundled files for every sampled note, including every percussion pad', () => {
        const project = template.create()
        const checked = new Set<string>()
        for (const track of project.tracks) {
          const def = instrumentDef(track.instrument)
          if (!def.set) continue
          const set = parseManifest(JSON.parse(readFileSync(new URL(`../../public/samples/${def.set}/manifest.json`, import.meta.url), 'utf8')), def.set)
          for (const note of notes(track)) {
            const zone = pickZone(set, note.pitch, note.velocity)
            expect(zone, `${track.name}: unmapped MIDI ${note.pitch}`).toBeDefined()
            if (!zone) continue
            if (def.isKit) expect(zone.root).toBe(note.pitch)
            const key = `${def.set}/${zone.file}`
            if (checked.has(key)) continue
            checked.add(key)
            for (const format of set.formats) {
              expect(existsSync(new URL(`../../public/samples/${key}.${format}`, import.meta.url)), key).toBe(true)
            }
          }
        }
        expect(checked.size).toBeGreaterThan(15)
      })

      it('starts with audible gugak notes, changes section density, and develops the melodic phrases', () => {
        const project = template.create()
        const gugak = project.tracks.filter(track => instrumentDef(track.instrument).category === 'gugak')
        expect(new Set(gugak.map(track => track.instrument))).toEqual(new Set(['samul', 'gayageum', 'daegeum', 'haegeum']))
        expect(gugak.some(track => midi(track).some(clip => clip.startBeat === 0 && clip.notes.some(note => note.start === 0 && note.velocity >= 0.5)))).toBe(true)
        const density = project.markers.map((marker, index) => {
          const end = project.markers[index + 1]?.startBeat ?? project.lengthBeats
          return project.tracks.flatMap(track => midi(track).filter(clip => clip.startBeat >= marker.startBeat && clip.startBeat < end)).reduce((sum, clip) => sum + clip.notes.length, 0) / (end - marker.startBeat)
        })
        expect(Math.max(...density)).toBeGreaterThan(Math.min(...density) * 1.8)
        const lead = project.tracks.find(track => track.instrument === 'gayageum')!
        expect(new Set(midi(lead).map(signature)).size).toBeGreaterThanOrEqual(4)
        expect(new Set(notes(lead).map(note => note.velocity)).size).toBeGreaterThan(4)
        // A thin ending leaves time for releases/reverb, instead of an abrupt all-track cut.
        expect(project.tracks.filter(track => midi(track).some(clip => clip.startBeat >= project.lengthBeats - 8)).length).toBeLessThanOrEqual(3)
      })
    })
  }
})

describe('musical identity and playability', () => {
  const scales: Record<string, readonly number[]> = {
    'madang-boombap': [0, 2, 5, 7, 9],
    'heukryu-trap': [1, 2, 4, 6, 8, 9, 11],
    'dalbit-fusion': [0, 2, 4, 6, 7, 9, 11],
  }
  it.each(PROJECT_TEMPLATES)('$name stays in its announced scale and the sampled instruments’ playable registers', template => {
    const project = template.create()
    const ranges: Record<string, [number, number]> = { gayageum: [45, 78], haegeum: [61, 79], daegeum: [62, 81] }
    for (const track of project.tracks) {
      if (instrumentDef(track.instrument).isKit) continue
      for (const note of notes(track)) {
        expect(scales[template.id], `${track.name}: ${note.pitch}`).toContain(note.pitch % 12)
        const range = ranges[track.instrument]
        if (range) {
          expect(note.pitch).toBeGreaterThanOrEqual(range[0])
          expect(note.pitch).toBeLessThanOrEqual(range[1])
        }
      }
    }
  })

  it('keeps wind, bowed-string and bass lines monophonic while plucked strings can ring together', () => {
    for (const template of PROJECT_TEMPLATES) {
      for (const track of template.create().tracks.filter(track => ['bass', 'daegeum', 'haegeum'].includes(track.instrument))) {
        for (const clip of midi(track)) {
          const sorted = [...clip.notes].sort((a, b) => a.start - b.start)
          for (let i = 1; i < sorted.length; i++) expect(sorted[i].start, `${template.name} / ${track.name} / ${clip.name}`).toBeGreaterThanOrEqual(sorted[i - 1].start + sorted[i - 1].duration - 1e-9)
        }
      }
    }
  })

  it('distinguishes relaxed boom-bap eighths from straight trap hats, rapid rolls and half-time backbeats', () => {
    const boom = createTemplateProject('madang-boombap')
    const trap = createTemplateProject('heukryu-trap')
    const boomHats = boom.tracks.find(track => track.name.includes('하이햇'))!
    expect(notes(boomHats).some(note => Math.abs(note.start % 1 - 0.555) < 1e-8)).toBe(true)
    const trapHats = trap.tracks.find(track => track.name.includes('하이햇'))!
    expect(midi(trapHats).some(clip => clip.notes.some((note, i) => i && note.start - clip.notes[i - 1].start <= 0.126))).toBe(true)
    const snares = trap.tracks.find(track => track.name.includes('클랩'))!
    for (const clip of midi(snares)) {
      const strong = clip.notes.filter(note => note.pitch === 38 && note.velocity > 0.7)
      expect(strong.map(note => note.start)).toEqual([2, 6])
    }
  })

  it('gives the fusion project two distinct bass roles and alternating wind/string calls', () => {
    const project = createTemplateProject('dalbit-fusion')
    const basses = project.tracks.filter(track => track.instrument === 'bass')
    expect(basses).toHaveLength(2)
    const averagePitch = (track: Track) => notes(track).reduce((sum, note) => sum + note.pitch, 0) / notes(track).length
    expect(averagePitch(basses[1]) - averagePitch(basses[0])).toBeGreaterThan(9)
    expect(midi(basses[0]).map(signature)).not.toEqual(midi(basses[1]).map(signature))
    const calls = project.tracks.find(track => track.instrument === 'daegeum')!
    const responses = project.tracks.find(track => track.instrument === 'haegeum')!
    expect(notes(calls).every(note => note.start + note.duration <= 4)).toBe(true)
    expect(notes(responses).every(note => note.start >= 4)).toBe(true)
    expect(notes(calls).some(note => note.pitch % 12 === 6)).toBe(true)
  })
})
