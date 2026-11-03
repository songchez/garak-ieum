import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runTokenCli } from './token'

describe('packaged MCP token output', () => {
  it('waits for the output write to finish before allowing the desktop process to exit', async () => {
    let text = ''
    let acknowledge: (() => void) | undefined
    const output = new Writable({
      write(chunk, _encoding, callback) { text += String(chunk); acknowledge = callback },
    })
    let completed = false
    const result = runTokenCli(output).then(() => { completed = true })
    await Promise.resolve()
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}\n$/)
    expect(completed).toBe(false)
    acknowledge!()
    await result
    expect(completed).toBe(true)
    expect(output.listenerCount('error')).toBe(0)
    output.destroy()
  })

  it('rejects a broken output pipe without leaking an unhandled stream error', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('output closed')) },
    })
    await expect(runTokenCli(output)).rejects.toThrow('output closed')
  })
})
