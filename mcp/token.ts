import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

/** A separate CLI action; the desktop host must await the write before exiting. */
export async function runTokenCli(output: Writable = process.stdout): Promise<void> {
  const token = `${randomBytes(32).toString('base64url')}\n`
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { reject(error) }
    output.once('error', failed)
    try {
      output.write(token, error => {
        if (error) {
          // Writable emits its error after the callback; retain the once listener until then.
          reject(error)
        } else {
          output.off('error', failed)
          resolve()
        }
      })
    } catch (error) {
      output.off('error', failed)
      reject(error)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTokenCli().catch(() => {
    process.stderr.write('가락이음 연결 키를 출력하지 못했습니다.\n')
    process.exitCode = 1
  })
}
