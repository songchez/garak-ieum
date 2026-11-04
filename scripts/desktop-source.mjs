import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { repository, sourceInfo } from './source-info.mjs'
import { nativeArchives } from './native-dependencies.mjs'

const info = sourceInfo({ requireClean: true })
const built = JSON.parse(await readFile(path.join(repository, 'dist', 'licenses', 'SOURCE.json'), 'utf8'))
if (JSON.stringify(built) !== JSON.stringify(info)) {
  throw new Error('The built app and source checkout differ. Rebuild from this clean commit before producing a source archive.')
}
const release = path.join(repository, 'release')
await mkdir(release, { recursive: true })
const prefix = `Garak-Ieum-Source-${info.version}/`
const nativeSources = await nativeArchives()
const sourceTime = execFileSync('git', ['show', '-s', '--format=%cI', info.commit], { cwd: repository, encoding: 'utf8' }).trim()
// Archive the entire tracked tree, including assets, the lockfile, vendored
// modules, CI and build/install scripts. No ignored files or developer secrets.
execFileSync('git', [
  // Stored ZIP entries avoid platform-specific zlib output. Explicit LF and
  // UTC avoid Git's Windows autocrlf and local-time archive transformations.
  '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
  'archive', '--format=zip', '-0', `--mtime=${sourceTime}`, `--output=${path.join(release, info.archive)}`,
  // Every binary release carries the exact verified dependency sources too.
  // Include the same ASIO/VST3/miniaudio/JSON archives on Windows and macOS so
  // the source ZIP is identical and can rebuild without their download hosts.
  `--prefix=${prefix}native/dependency-sources/`, ...nativeSources.map(source => `--add-file=${source.file}`),
  `--prefix=${prefix}`,
  `--add-virtual-file=${prefix}SOURCE_VERSION.json:${JSON.stringify(info, null, 2)}\n`, info.commit,
], { cwd: repository, stdio: 'inherit', windowsHide: true, env: { ...process.env, TZ: 'UTC' } })
await copyFile(path.join(repository, 'dist', 'licenses', 'SOURCE.txt'), path.join(release, 'SOURCE.txt'))
await copyFile(path.join(repository, 'LICENSE'), path.join(release, 'LICENSE.txt'))
await copyFile(path.join(repository, 'dist', 'licenses', 'THIRD_PARTY_NOTICES.txt'), path.join(release, 'THIRD_PARTY_NOTICES.txt'))
console.log(`Prepared matching project source: ${info.archive}`)
