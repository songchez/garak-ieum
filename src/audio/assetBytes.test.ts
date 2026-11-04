import { describe, expect, it } from 'vitest'
import { ownAudioBytes } from './assetBytes'

describe('owned audio asset bytes', () => {
  it('keeps an in-memory copy that stays readable when the source no longer is', async () => {
    let readable = true
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3])
    // A disk-backed File/IndexedDB Blob that becomes unreadable once its file moves.
    const source = Object.assign(new Blob([bytes], { type: 'audio/wav' }), {
      arrayBuffer: async () => { if (!readable) throw new DOMException('The requested file could not be read', 'NotReadableError'); return bytes.slice().buffer },
    })
    const owned = await ownAudioBytes(source, 'take.wav')
    readable = false
    expect(owned.blob).not.toBe(source)
    expect(owned.blob.type).toBe('audio/wav')
    expect(new Uint8Array(await owned.blob.arrayBuffer())).toEqual(bytes)
    await expect(source.arrayBuffer()).rejects.toThrow('could not be read')
  })

  it('names the file instead of surfacing NotReadableError when the source is already gone', async () => {
    const gone = Object.assign(new Blob([]), { arrayBuffer: async () => { throw new DOMException('The requested file could not be read', 'NotReadableError') } })
    await expect(ownAudioBytes(gone, 'vocal.wav')).rejects.toThrow("'vocal.wav' 파일을 읽지 못했습니다")
  })
})
