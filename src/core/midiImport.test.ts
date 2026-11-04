import { describe, expect, it } from 'vitest'
import { MAX_MIDI_FILE_BYTES, parseMidiFile } from './midiImport'

const ascii = (value: string): number[] => Array.from(value, char => char.charCodeAt(0))
const u16 = (value: number): number[] => [value >>> 8 & 255, value & 255]
const u32 = (value: number): number[] => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255]
function variable(value: number): number[] {
  const bytes = [value & 127]
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128)
  return bytes
}
const event = (ticks: number, ...data: number[]): number[] => [...variable(ticks), ...data]
const meta = (ticks: number, type: number, data: number[]): number[] => [...variable(ticks), 0xff, type, ...variable(data.length), ...data]
const name = (value: string): number[] => meta(0, 3, [...new TextEncoder().encode(value)])
const end = (ticks = 0): number[] => meta(ticks, 0x2f, [])
const tempo = (ticks: number, value: number): number[] => meta(ticks, 0x51, [value >>> 16 & 255, value >>> 8 & 255, value & 255])
const meter = (ticks: number, numerator: number, exponent: number): number[] => meta(ticks, 0x58, [numerator, exponent, 24, 8])
const chunk = (id: string, data: number[]): number[] => [...ascii(id), ...u32(data.length), ...data]
function smf(tracks: number[][], format = tracks.length > 1 ? 1 : 0, ppq = 480, headerExtra: number[] = []): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...chunk('MThd', [...u16(format), ...u16(tracks.length), ...u16(ppq), ...headerExtra]), ...tracks.flatMap(data => chunk('MTrk', data))])
}
const oneNote = (): number[] => [...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0), ...end()]

describe('standard MIDI file import', () => {
  it('reads a literal SMF byte sequence into beats and normalized velocity', () => {
    // Independently written Type 0: PPQ 96, piano program 0, note C4 for one beat.
    const data = new Uint8Array([
      0x4d,0x54,0x68,0x64,0,0,0,6,0,0,0,1,0,0x60,
      0x4d,0x54,0x72,0x6b,0,0,0,15,
      0,0xc0,0, 0,0x90,60,127, 0x60,0x80,60,64, 0,0xff,0x2f,0,
    ])
    const before = data.slice()
    expect(parseMidiFile(data)).toEqual({
      tracks: [{ name: 'MIDI 트랙 1', channel: 0, program: 0, notes: [{ pitch: 60, start: 0, duration: 1, velocity: 1 }] }],
      lengthBeats: 1, bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, warnings: [],
    })
    expect(data).toEqual(before)
  })

  it('imports Type 1 conductor metadata and separate pitched/percussion parts', () => {
    const data = smf([
      [...name('Conductor'), ...tempo(0, 600_000), ...meter(0, 6, 3), ...end(1920)],
      [...name('피아노'), ...event(0, 0xc0, 4), ...event(480, 0x90, 60, 64), ...event(480, 0x80, 60, 0), ...end(960)],
      [...name('드럼'), ...event(0, 0x99, 36, 127), ...event(120, 0x89, 36, 0), ...end(1800)],
    ])
    const result = parseMidiFile(data.buffer)
    expect(result.bpm).toBe(100)
    expect(result.timeSignature).toEqual({ numerator: 6, denominator: 8 })
    expect(result.lengthBeats).toBe(4)
    expect(result.tracks).toEqual([
      { name: '피아노', channel: 0, program: 4, notes: [{ pitch: 60, start: 1, duration: 1, velocity: 64 / 127 }] },
      { name: '드럼', channel: 9, notes: [{ pitch: 36, start: 0, duration: .25, velocity: 1 }] },
    ])
    expect(result.warnings).toEqual([])
  })

  it('splits a multi-channel Type 0 track and accepts running-status velocity-zero note-offs', () => {
    const result = parseMidiFile(smf([[
      ...name('Band'), ...event(0, 0xc0, 32), ...event(0, 0x90, 48, 90),
      ...event(240, 52, 70), ...event(240, 48, 0), ...event(240, 52, 0),
      ...event(0, 0x99, 36, 120), ...event(120, 36, 0), ...end(),
    ]]))
    expect(result.tracks.map(track => [track.name, track.channel, track.program])).toEqual([
      ['Band · Ch 1', 0, 32], ['Band · Ch 10', 9, undefined],
    ])
    expect(result.tracks[0].notes).toEqual([
      { pitch: 48, start: 0, duration: 1, velocity: 90 / 127 },
      { pitch: 52, start: .5, duration: 1, velocity: 70 / 127 },
    ])
    expect(result.tracks[1].notes[0]).toMatchObject({ pitch: 36, start: 1.5, duration: .25 })
  })

  it('pairs repeated overlapping pitches FIFO without overwriting a note', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0x90, 60, 100), ...event(120, 60, 80),
      ...event(120, 0x80, 60, 0), ...event(120, 60, 0), ...end(),
    ]]))
    expect(result.tracks[0].notes).toEqual([
      { pitch: 60, start: 0, duration: .5, velocity: 100 / 127 },
      { pitch: 60, start: .25, duration: .5, velocity: 80 / 127 },
    ])
    expect(result.warnings).toEqual([])
  })

  it('keeps same-pitch notes on different channels independent', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0x90, 60, 100), ...event(0, 0x91, 60, 50),
      ...event(240, 0x80, 60, 0), ...event(720, 0x81, 60, 0), ...end(),
    ]]))
    expect(result.tracks.map(track => [track.channel, track.notes[0].duration])).toEqual([[0, .5], [1, 2]])
  })

  it('handles one-data-byte program/channel-pressure running status without losing alignment', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0xc0, 1), ...event(0, 12), ...event(0, 0xd0, 20), ...event(0, 30),
      ...oneNote(),
    ]]))
    expect(result.tracks[0].program).toBe(12)
    expect(result.tracks[0].notes[0]).toMatchObject({ pitch: 60, duration: 1 })
    expect(result.warnings.filter(value => value.includes('애프터터치'))).toHaveLength(1)
  })

  it('extends released notes to sustain pedal-up and respects the 64 threshold', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0xb0, 64, 64), ...event(0, 0x90, 60, 100),
      ...event(240, 0x80, 60, 0), ...event(240, 0x90, 60, 80),
      ...event(240, 0x80, 60, 0), ...event(240, 0xb0, 64, 63), ...end(),
    ]]))
    expect(result.tracks[0].notes.map(note => [note.start, note.duration])).toEqual([[0, 2], [1, 1]])
    expect(result.warnings).toEqual([])
  })

  it('merges shared-channel program and sustain events from other SMF tracks in musical order', () => {
    const result = parseMidiFile(smf([
      [...name('Notes'), ...event(240, 0x90, 60, 100), ...event(240, 0x80, 60, 0), ...end(480)],
      [...event(0, 0xc0, 33), ...event(0, 0xb0, 64, 127), ...event(960, 64, 0), ...end()],
    ]))
    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]).toMatchObject({ name: 'Notes', program: 33, notes: [{ start: .5, duration: 1.5 }] })
  })

  it('keeps MIDI ports isolated when they reuse a channel', () => {
    const result = parseMidiFile(smf([
      [...meta(0, 0x21, [0]), ...event(0, 0xc0, 3), ...oneNote()],
      [...meta(0, 0x21, [1]), ...event(0, 0xc0, 40), ...event(0, 0xb0, 64, 127), ...event(0, 0x90, 60, 90), ...event(240, 0x80, 60, 0), ...event(720, 0xb0, 64, 0), ...end()],
    ]))
    expect(result.tracks.map(track => [track.program, track.notes[0].duration])).toEqual([[3, 1], [40, 2]])
  })

  it('uses All Notes Off, Reset All Controllers and All Sound Off to close the right notes', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0xb0, 64, 127), ...event(0, 0x90, 60, 100),
      ...event(240, 0xb0, 123, 0), ...event(240, 121, 0),
      ...event(0, 0x90, 62, 100), ...event(0, 0xb0, 64, 127),
      ...event(120, 0x80, 62, 0), ...event(120, 0xb0, 120, 0), ...end(),
    ]]))
    expect(result.tracks[0].notes.map(note => [note.pitch, note.start, note.duration])).toEqual([[60, 0, 1], [62, 1, .5]])
    expect(result.warnings).toEqual([])
  })

  it('does not release physically held notes when resetting the sustain controller', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0xb0, 64, 127), ...event(0, 0x90, 60, 100),
      ...event(240, 0xb0, 121, 0), ...event(240, 0x80, 60, 0), ...end(),
    ]]))
    expect(result.tracks[0].notes[0].duration).toBe(1)
  })

  it('closes unfinished notes at their own track end and reports the recovery', () => {
    const result = parseMidiFile(smf([
      [...event(0, 0x90, 60, 100), ...end(960)],
      [...tempo(0, 500_000), ...end(4800)],
    ]))
    expect(result.tracks[0].notes[0].duration).toBe(2)
    expect(result.lengthBeats).toBe(10)
    expect(result.warnings.join(' ')).toMatch(/종료\(Note Off\)가 없는/)
    const held = parseMidiFile(smf([[
      ...event(0, 0xb0, 64, 127), ...event(0, 0x90, 60, 100), ...event(240, 0x80, 60, 0), ...end(720),
    ]]))
    expect(held.tracks[0].notes[0].duration).toBe(2)
    expect(held.warnings.join(' ')).toMatch(/파일 끝까지 유지된 서스테인/)
  })

  it('recovers zero-tick notes with a disclosed one-tick duration and skips unmatched offs', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0x80, 61, 0), ...event(0, 0x90, 60, 100), ...event(0, 60, 0), ...end(),
    ]]))
    expect(result.tracks[0].notes[0].duration).toBe(1 / 480)
    expect(result.lengthBeats).toBe(1 / 480)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.join(' ')).toMatch(/1틱/)
    expect(result.warnings.join(' ')).toMatch(/짝이 없는/)
  })

  it('warns about changing tempo, meter and program while preserving beat positions', () => {
    const result = parseMidiFile(smf([[
      ...tempo(0, 500_000), ...meter(0, 4, 2), ...event(0, 0xc0, 0),
      ...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0),
      ...tempo(0, 600_000), ...meter(0, 3, 2), ...event(0, 0xc0, 40),
      ...event(0, 0x90, 62, 100), ...event(480, 0x80, 62, 0), ...end(),
    ]]))
    expect(result.bpm).toBe(120)
    expect(result.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    expect(result.tracks[0].program).toBe(0)
    expect(result.tracks[0].notes.map(note => [note.start, note.duration])).toEqual([[0, 1], [1, 1]])
    expect(result.warnings.join(' ')).toMatch(/템포 변경/)
    expect(result.warnings.join(' ')).toMatch(/박자표 변경/)
    expect(result.warnings.join(' ')).toMatch(/Program Change/)
  })

  it('uses SMF defaults before a late first tempo/meter instead of moving the first bar', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0x90, 60, 100), ...tempo(480, 1_000_000), ...meter(0, 7, 3), ...event(480, 0x80, 60, 0), ...end(),
    ]]))
    expect(result.bpm).toBe(120)
    expect(result.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    expect(result.tracks[0].notes[0].duration).toBe(2)
    expect(result.warnings).toHaveLength(2)
  })

  it('reports ignored expressive messages once without corrupting following notes', () => {
    const result = parseMidiFile(smf([[
      ...event(0, 0xb0, 7, 90), ...event(0, 10, 20), ...event(0, 1, 40),
      ...event(0, 0xe0, 0, 70), ...event(0, 0xa0, 60, 40), ...event(0, 0xd0, 70), ...oneNote(),
    ]]))
    expect(result.tracks[0].notes[0]).toMatchObject({ pitch: 60, duration: 1, velocity: 100 / 127 })
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join(' ')).toMatch(/MIDI CC/)
    expect(result.warnings.join(' ')).toMatch(/피치 벤드/)
    expect(result.warnings.join(' ')).toMatch(/애프터터치/)
  })

  it('skips bounded SysEx packets, unknown chunks and long unknown meta payloads', () => {
    const track = [
      ...event(0, 0xf0, 4, 0x7d, 0x01, 0x02, 0xf7),
      ...event(0, 0xf7, 3, 0x80, 0xff, 0xf7),
      ...meta(0, 0x70, Array(130).fill(0x90)), ...oneNote(),
    ]
    const file = smf([track], 0, 480, [17, 19])
    const data = new Uint8Array([...file.subarray(0, 16), ...chunk('TEST', [1,2,3]), ...file.subarray(16), ...chunk('MORE', [])])
    const result = parseMidiFile(data)
    expect(result.tracks[0].notes[0].duration).toBe(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/SysEx/)
  })

  it('honors extended known meta-event lengths and cleans UTF-8 labels', () => {
    const result = parseMidiFile(smf([[
      ...name('\0피아노\n 리드\0'), ...meta(0, 0x51, [7, 0xa1, 0x20, 99]),
      ...meta(0, 0x58, [4,2,24,8,99]), ...oneNote(),
    ]]))
    expect(result.tracks[0].name).toBe('피아노 리드')
    expect(result.bpm).toBe(120)
    expect(result.timeSignature).toEqual({ numerator: 4, denominator: 4 })
  })

  it('reads only the supplied Uint8Array view', () => {
    const file = smf([oneNote()])
    const wrapped = new Uint8Array(file.length + 16)
    wrapped.fill(0xaa); wrapped.set(file, 7)
    expect(parseMidiFile(wrapped.subarray(7, 7 + file.length))).toEqual(parseMidiFile(file))
  })

  it('accepts four-byte delta times without bitwise overflow', () => {
    const result = parseMidiFile(smf([[
      ...event(0,0x90,60,100), ...event(0x0fffffff,0x80,60,0), ...end(),
    ]],0,32767))
    expect(result.tracks[0].notes[0].duration).toBe(0x0fffffff / 32767)
    expect(result.lengthBeats).toBe(0x0fffffff / 32767)
  })

  it('returns metadata-only files without inventing notes or tracks', () => {
    const result = parseMidiFile(smf([[...tempo(0,600_000), ...end(480)]]))
    expect(result).toMatchObject({ tracks: [], bpm: 100, lengthBeats: 1, warnings: [] })
  })
})

describe('malformed and bounded MIDI imports', () => {
  it('rejects invalid headers, track counts and unsupported timing with actionable errors', () => {
    expect(() => parseMidiFile(new Uint8Array())).toThrow(/잘렸/)
    expect(() => parseMidiFile(new TextEncoder().encode('not a MIDI file'))).toThrow(/표준 MIDI/)
    expect(() => parseMidiFile(new Uint8Array([...ascii('MThd'), ...u32(5), 0,0,0,1,0]))).toThrow(/헤더/)
    expect(() => parseMidiFile(smf([oneNote()],2))).toThrow(/Type 0 또는 Type 1/)
    expect(() => parseMidiFile(smf([oneNote()],3))).toThrow(/지원하지 않는 MIDI 형식/)
    expect(() => parseMidiFile(smf([oneNote()],0,0xe728))).toThrow(/SMPTE.*PPQ/)
    expect(() => parseMidiFile(smf([oneNote()],0,0))).toThrow(/PPQ/)
    expect(() => parseMidiFile(smf([],1))).toThrow(/트랙 수/)
    expect(() => parseMidiFile(smf([oneNote(),oneNote()],0))).toThrow(/트랙 수/)
    const tooMany = new Uint8Array(chunk('MThd',[...u16(1),...u16(257),...u16(480)]))
    expect(() => parseMidiFile(tooMany)).toThrow(/256/)
  })

  it('rejects truncated payloads, missing tracks and contradictory chunk lengths', () => {
    const good = smf([oneNote()])
    for (const cutoff of [1,5,10,13,15,good.length-1]) expect(() => parseMidiFile(good.subarray(0,cutoff))).toThrow()
    const longTrack = good.slice(); longTrack.set([255,255,255,255],18)
    expect(() => parseMidiFile(longTrack)).toThrow(/청크 길이/)
    const missingTrack = good.slice(); missingTrack[9] = 1; missingTrack[11] = 2
    expect(() => parseMidiFile(missingTrack)).toThrow(/트랙.*모두/)
    expect(() => parseMidiFile(new Uint8Array([...good,...chunk('MTrk',end())]))).toThrow(/많은 MIDI 트랙/)
    expect(() => parseMidiFile(new Uint8Array([...good,...ascii('TEST'),...u32(0xffffffff)]))).toThrow(/청크 길이/)
    expect(() => parseMidiFile(smf([[]]))).toThrow(/End of Track/)
  })

  it('rejects malformed running status, data bytes and unterminated variable lengths', () => {
    const invalidTracks = [
      [...event(0,60,100), ...end()],
      [...event(0,0x90,60,100), ...meta(0,1,[]), ...event(1,60,0), ...end()],
      [...event(0,0x90,60,100), ...event(0,0xf0,1,0xf7), ...event(1,60,0), ...end()],
      [...event(0,0x90,60,0x80), ...end()],
      [0x81,0x80,0x80,0x80,0,0x90,60,100,...end()],
      [0x81],
      [...event(0,0xf8), ...end()],
      [...event(0,0xff,0x80,0), ...end()],
    ]
    for (const track of invalidTracks) expect(() => parseMidiFile(smf([track]))).toThrow(/MIDI 파일/)
    expect(() => parseMidiFile(smf([oneNote(),[...event(0,60,100),...end()]],1))).toThrow(/running status/)
  })

  it('rejects invalid tempo, meter, channel/port metadata and end-of-track placement', () => {
    const invalidTracks = [
      [...tempo(0,0), ...end()], [...meta(0,0x51,[1,2]), ...end()],
      [...meter(0,0,2), ...end()], [...meta(0,0x58,[4,2,24]), ...end()],
      [...meta(0,0x20,[16]), ...end()], [...meta(0,0x21,[]), ...end()],
      [...meta(0,0x2f,[0])], [...end(),0], [...event(0,0x90,60,100)],
    ]
    for (const track of invalidTracks) expect(() => parseMidiFile(smf([track]))).toThrow(/MIDI 파일/)
  })

  it('enforces the file byte and duration bounds before producing a project', () => {
    expect(() => parseMidiFile(new Uint8Array(MAX_MIDI_FILE_BYTES+1))).toThrow(/16 MiB/)
    expect(() => parseMidiFile(smf([[...end(24_000*480+1)]]))).toThrow(/24,000박/)
  })

  it('bounds note counts and channel-split output tracks', () => {
    const notes: number[] = []
    for (let i=0;i<100_001;++i) notes.push(0,0x90,60,100)
    notes.push(...end())
    expect(() => parseMidiFile(smf([notes]))).toThrow(/100,000개/)
    const tracks = Array.from({length:17},() => {
      const events: number[] = []
      for (let channel=0;channel<16;++channel) events.push(...event(0,0x90+channel,60,100),...event(1,0x80+channel,60,0))
      return [...events,...end()]
    })
    expect(() => parseMidiFile(smf(tracks))).toThrow(/노트 트랙이 256개/)
  })

  it('bounds ignored event counts as well as stored note events', () => {
    const events = new Array<number>(500_001*4)
    for (let i=0;i<500_001;++i) { const at=i*4; events[at]=0; events[at+1]=0xff; events[at+2]=0x7f; events[at+3]=0 }
    events.push(...end())
    expect(() => parseMidiFile(smf([events]))).toThrow(/500,000개/)
  })

  it('preserves valid metadata outside the project UI range for the caller to validate', () => {
    const result = parseMidiFile(smf([[...tempo(0,3_000_000),...meter(0,5,5),...oneNote()]]))
    expect(result.bpm).toBe(20)
    expect(result.timeSignature).toEqual({ numerator: 5, denominator: 32 })
  })
})
