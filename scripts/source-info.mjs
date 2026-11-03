import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = fileURLToPath(new URL('../', import.meta.url))
export const repositoryUrl = 'https://github.com/songchez/garak-ieum'
const gitOptions = { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
export const git = args => execFileSync('git', args, gitOptions).trim()

export function sourceInfo({ requireClean = false } = {}) {
  const { version } = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid source package version')
  let commit = null, dirty = null, origin = 'unknown'
  try {
    // An extracted source archive may sit inside an unrelated Git repository.
    const root = path.resolve(git(['rev-parse', '--show-toplevel']))
    const here = path.resolve(repository)
    const sameRoot = process.platform === 'win32' ? root.toLowerCase() === here.toLowerCase() : root === here
    if (sameRoot) {
      commit = git(['rev-parse', 'HEAD'])
      dirty = git(['status', '--porcelain', '--untracked-files=normal']).length !== 0
      origin = 'git'
    }
  } catch { /* A downloaded source archive does not include .git. */ }
  if (origin !== 'git') {
    try {
      const saved = JSON.parse(readFileSync(path.join(repository, 'SOURCE_VERSION.json'), 'utf8'))
      if (saved.schemaVersion === 1 && saved.version === version && saved.repository === repositoryUrl && /^[a-f0-9]{40}$/.test(saved.commit)) {
        commit = saved.commit
        origin = 'archive'
      }
    } catch { /* An unversioned development copy can still run locally. */ }
  }
  if (commit !== null && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit')
  if (requireClean && (origin !== 'git' || dirty !== false)) {
    throw new Error('Source distribution requires a clean Git checkout. Commit source changes and rebuild before packaging the source archive.')
  }
  return {
    schemaVersion: 1, version, repository: repositoryUrl, commit, origin, dirty,
    archive: commit && dirty !== true ? `Garak-Ieum-Source-${version}-${commit.slice(0, 12)}.zip` : null,
  }
}
