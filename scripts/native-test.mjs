import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const fixture = (await readFile(path.join(repository, 'build/native-work/vst3-fixture-Release.txt'), 'utf8')).trim()
await access(fixture)
execFileSync(process.execPath, [path.join(repository, 'scripts/native-smoke.mjs'), '--plugin', fixture], {
  cwd: repository, stdio: 'inherit', windowsHide: true,
})
