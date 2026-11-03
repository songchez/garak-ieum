import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { repository, sourceInfo } from './source-info.mjs'

const info = sourceInfo({ requireClean: true })
const built = JSON.parse(await readFile(path.join(repository, 'dist', 'licenses', 'SOURCE.json'), 'utf8'))
if (JSON.stringify(built) !== JSON.stringify(info)) {
  throw new Error('The built app and source checkout differ. Rebuild from this clean commit before producing a source archive.')
}
const release = path.join(repository, 'release')
await mkdir(release, { recursive: true })
const prefix = `Garak-Ieum-Source-${info.version}/`
// Archive the entire tracked tree, including assets, the lockfile, vendored
// modules, CI and build/install scripts. No ignored files or developer secrets.
execFileSync('git', [
  'archive', '--format=zip', `--prefix=${prefix}`, `--output=${path.join(release, info.archive)}`,
  `--add-virtual-file=${prefix}SOURCE_VERSION.json:${JSON.stringify(info, null, 2)}\n`, info.commit,
], { cwd: repository, stdio: 'inherit', windowsHide: true })
await copyFile(path.join(repository, 'dist', 'licenses', 'SOURCE.txt'), path.join(release, 'SOURCE.txt'))
await copyFile(path.join(repository, 'LICENSE'), path.join(release, 'LICENSE.txt'))
await copyFile(path.join(repository, 'dist', 'licenses', 'THIRD_PARTY_NOTICES.txt'), path.join(release, 'THIRD_PARTY_NOTICES.txt'))
console.log(`Prepared matching project source: ${info.archive}`)
