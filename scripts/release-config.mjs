// SPDX-License-Identifier: GPL-3.0-only
import { execFileSync } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const releaseRepository = 'songchez/garak-ieum'
export const releaseRoot = fileURLToPath(new URL('../', import.meta.url))
export const configFilename = 'release.config.json'
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/
const shaPattern = /^[a-f0-9]{40}$/

export function validVersion(version) {
  return typeof version === 'string' && version.length <= 64 && versionPattern.test(version)
}

export function validateReleaseConfig(value, packageVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release configuration must be an object.')
  const keys = ['schemaVersion', 'version', 'channel', 'publish', 'notes']
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Release configuration must contain exactly schemaVersion, version, channel, publish and notes.')
  }
  if (value.schemaVersion !== 1) throw new Error('Unsupported release configuration schema.')
  if (!validVersion(value.version) || value.version !== packageVersion) {
    throw new Error('Release version must be a valid SemVer matching package.json exactly (without build metadata).')
  }
  if (!['preview', 'stable'].includes(value.channel)) throw new Error('Release channel must be preview or stable.')
  if (value.channel === 'stable' && value.version.includes('-')) throw new Error('A stable release cannot use a prerelease version.')
  if (typeof value.publish !== 'boolean') throw new Error('Release publish must be a boolean.')
  if (typeof value.notes !== 'string' || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value.notes)) {
    throw new Error('Release notes must be one Markdown file directly inside releases/.')
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]))
}

export async function readReleaseSettings(root = releaseRoot) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const config = validateReleaseConfig(JSON.parse(await readFile(path.join(root, configFilename), 'utf8')), pkg.version)
  const notesPath = path.join(root, config.notes)
  const info = await lstat(notesPath)
  const resolved = await realpath(notesPath)
  const notesRoot = path.join(await realpath(root), 'releases')
  if (!info.isFile() || info.isSymbolicLink() || path.dirname(resolved) !== notesRoot || info.size > 64 * 1024) {
    throw new Error('Release notes must be a regular, local file no larger than 64 KiB.')
  }
  const notes = await readFile(notesPath, 'utf8')
  if (!notes.trim()) throw new Error('Release notes cannot be empty.')
  return { config, notes, version: config.version, tag: `v${config.version}` }
}

export function releaseDecision({ config, previousConfig, eventName, ref, repository }) {
  if (eventName !== 'push' || ref !== 'refs/heads/main') return { publish: false, reason: 'validation-only' }
  if (repository !== releaseRepository) throw new Error('Public release publishing is restricted to the application repository.')
  if (!config.publish) return { publish: false, reason: 'publishing-disabled' }
  if (previousConfig && JSON.stringify(config) === JSON.stringify(Object.fromEntries(
    Object.keys(config).map(key => [key, previousConfig[key]]),
  ))) return { publish: false, reason: 'release-configuration-unchanged' }
  return { publish: true, reason: 'release-requested-by-commit' }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

export async function readReleasePlan({ root = releaseRoot, env = process.env, event } = {}) {
  const settings = await readReleaseSettings(root)
  const commit = git(root, ['rev-parse', 'HEAD'])
  if (!shaPattern.test(commit) || (env.GITHUB_SHA && env.GITHUB_SHA !== commit)) {
    throw new Error('The checked out source does not match the workflow commit.')
  }
  let previousConfig = null
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') {
    const payload = event ?? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    if (!shaPattern.test(payload.before ?? '') || payload.after !== commit || payload.ref !== env.GITHUB_REF || payload.deleted === true) {
      throw new Error('Release planning requires the exact main push event and its before/after commits.')
    }
    if (!/^0{40}$/.test(payload.before)) {
      // Full history is fetched by the release workflow. Never interpret a
      // missing old commit as permission to publish an unchanged configuration.
      git(root, ['cat-file', '-e', `${payload.before}^{commit}`])
      git(root, ['merge-base', '--is-ancestor', payload.before, commit])
      const previousPaths = git(root, ['ls-tree', '--name-only', payload.before, '--', configFilename])
      if (previousPaths) previousConfig = JSON.parse(git(root, ['show', `${payload.before}:${configFilename}`]))
    }
  }
  return {
    ...settings, commit,
    ...releaseDecision({ config: settings.config, previousConfig, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, repository: env.GITHUB_REPOSITORY }),
  }
}

export async function prepareRelease(args, root = releaseRoot) {
  const options = { publish: false, channel: 'preview' }
  const values = [...args]
  if (values[0] === '--') values.shift()
  for (let index = 0; index < values.length; index++) {
    const key = values[index]
    if (key === '--publish') { options.publish = true; continue }
    if (!['--version', '--channel', '--notes'].includes(key) || !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error('Usage: pnpm release:prepare --version <SemVer> [--channel preview|stable] [--notes releases/file.md] [--publish]')
    }
    options[key.slice(2)] = values[++index]
  }
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const config = validateReleaseConfig({
    schemaVersion: 1, version: options.version, channel: options.channel,
    publish: options.publish, notes: options.notes ?? `releases/${options.version}.md`,
  }, options.version)
  const notesPath = path.join(root, config.notes)
  await mkdir(path.join(root, 'releases'), { recursive: true })
  if (await realpath(path.join(root, 'releases')) !== path.join(await realpath(root), 'releases')) {
    throw new Error('Release notes directory must be inside this checkout, not a symbolic link.')
  }
  if (await lstat(notesPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })) {
    const existing = await lstat(notesPath)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Existing release notes must be a regular file.')
  } else {
    await writeFile(notesPath, `# 가락이음 ${config.version}${config.channel === 'preview' ? ' 개발 프리뷰' : ''}\n\n## 변경 사항\n\n- 이번 버전의 변경 사항을 작성해 주세요.\n`, { flag: 'wx' })
  }
  pkg.version = config.version
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(path.join(root, configFilename), `${JSON.stringify(config, null, 2)}\n`)
  return config
}

async function main() {
  const command = process.argv[2]
  if (command === 'prepare') {
    const config = await prepareRelease(process.argv.slice(3))
    console.log(`Prepared ${config.version} (${config.channel}), publish=${config.publish}. Edit ${config.notes}, review and commit these changes to main.`)
    console.log('No commit, tag, upload or release was created by this command.')
    return
  }
  if (command === 'check') {
    const { config } = await readReleaseSettings()
    console.log(`PASS release settings: ${config.version}, ${config.channel}, publish=${config.publish}`)
    return
  }
  if (command === 'plan') {
    const plan = await readReleasePlan()
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `publish=${plan.publish}\nversion=${plan.version}\ntag=${plan.tag}\nchannel=${plan.config.channel}\ncommit=${plan.commit}\n`)
    console.log(`Release plan: ${plan.reason} (${plan.tag}, ${plan.commit})`)
    return
  }
  throw new Error('Use release-config.mjs check, plan or prepare.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
