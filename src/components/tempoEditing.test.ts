import { describe, expect, it } from 'vitest'
import { editTempo, type TempoDraft } from './tempoEditing'

describe('tempo text editing', () => {
  it('allows clearing and typing incomplete values without committing them to playback', () => {
    let draft = editTempo(null, { type: 'focus' }, 120).draft
    for (const text of ['', '9', '95']) {
      const next = editTempo(draft, { type: 'input', text }, 120)
      expect(next.commit).toBeUndefined()
      expect(next.draft?.text).toBe(text)
      draft = next.draft
    }
    expect(editTempo(draft, { type: 'commit' }, 120)).toEqual({ draft: null, commit: 95 })
  })

  it('rejects letters, signs, exponents, fractions, spaces and mixed pasted content', () => {
    const draft: TempoDraft = { text: '95', dirty: true }
    for (const text of ['a', '1e2', '1E2', '+90', '-90', '90.5', '9/8', ' 90', '90 ', '90 BPM', '한글', '１２']) {
      expect(editTempo(draft, { type: 'input', text }, 120)).toEqual({ draft })
    }
  })

  it('clamps completed values to the existing 30–300 BPM range', () => {
    for (const [text, value] of [['0', 30], ['29', 30], ['30', 30], ['300', 300], ['301', 300], ['9999', 300], ['9'.repeat(400), 300]] as const) {
      expect(editTempo({ text, dirty: true }, { type: 'commit' }, 120)).toEqual({ draft: null, commit: value })
    }
    expect(editTempo({ text: '0095', dirty: true }, { type: 'commit' }, 120)).toEqual({ draft: null, commit: 95 })
  })

  it('restores the latest tempo when an empty edit is blurred', () => {
    expect(editTempo({ text: '', dirty: true }, { type: 'commit' }, 135)).toEqual({ draft: null })
  })

  it('commits Enter once even when the resulting blur commits again', () => {
    const enter = editTempo({ text: '95', dirty: true }, { type: 'commit' }, 120)
    expect(enter.commit).toBe(95)
    expect(editTempo(enter.draft, { type: 'commit' }, 120)).toEqual({ draft: null })
    expect(editTempo({ text: '120', dirty: true }, { type: 'commit' }, 120).commit).toBeUndefined()
  })

  it('cancels an edit before Escape blurs the field', () => {
    const cancelled = editTempo({ text: '95', dirty: true }, { type: 'cancel' }, 120)
    expect(cancelled).toEqual({ draft: null })
    expect(editTempo(cancelled.draft, { type: 'commit' }, 120).commit).toBeUndefined()
  })

  it('keeps up/down steps within range and steps from a typed or emptied value', () => {
    expect(editTempo(null, { type: 'step', delta: 1 }, 120).commit).toBe(121)
    expect(editTempo(null, { type: 'step', delta: -1 }, 120).commit).toBe(119)
    expect(editTempo({ text: '95', dirty: true }, { type: 'step', delta: 1 }, 120).commit).toBe(96)
    expect(editTempo({ text: '', dirty: true }, { type: 'step', delta: -1 }, 120).commit).toBe(119)
    expect(editTempo({ text: '29', dirty: true }, { type: 'step', delta: 1 }, 120).commit).toBe(30)
    expect(editTempo({ text: '301', dirty: true }, { type: 'step', delta: -1 }, 120).commit).toBe(300)
    expect(editTempo(null, { type: 'step', delta: -1 }, 30).commit).toBeUndefined()
    expect(editTempo(null, { type: 'step', delta: 1 }, 300).commit).toBeUndefined()
    const step = editTempo(null, { type: 'step', delta: 1 }, 120)
    expect(editTempo(step.draft, { type: 'step', delta: 1 }, 120).commit).toBe(122)
    expect(editTempo(step.draft, { type: 'commit' }, 121).commit).toBeUndefined()
  })

  it('reflects external tempo updates without overwriting an unfinished edit', () => {
    const clean = editTempo(null, { type: 'focus' }, 120).draft
    expect(editTempo(clean, { type: 'sync' }, 135).draft?.text).toBe('135')
    const dirty: TempoDraft = { text: '9', dirty: true }
    expect(editTempo(dirty, { type: 'sync' }, 135).draft).toBe(dirty)
    expect(editTempo(editTempo(clean, { type: 'sync' }, 135).draft, { type: 'commit' }, 135).commit).toBeUndefined()
  })
})
