// SPDX-License-Identifier: GPL-3.0-only
// Explicitly named *-tests.mjs so Vitest does not collect Node's test runner.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileDigest, parseChecksums, readSourceIdentity, releaseNames, stageReleaseAssets } from './release-artifacts.mjs'
import { prepareRelease, readReleasePlan, readReleaseSettings, releaseDecision, releaseRepository, validateReleaseConfig } from './release-config.mjs'
import { githubClient, publishRelease } from './release-publish.mjs'

const config = (changes = {}) => ({ schemaVersion: 1, version: '1.2.3', channel: 'preview', publish: false, notes: 'releases/1.2.3.md', ...changes })
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options }).trim()

async function repositoryFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garak-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'releases'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }))
  await writeFile(path.join(root, 'release.config.json'), JSON.stringify(config()))
  await writeFile(path.join(root, 'releases/1.2.3.md'), '# Release fixture\n\n- Change\n')
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'core.autocrlf', 'false'])
  const commit = () => {
    git(root, ['add', '.'])
    git(root, ['-c', 'user.name=Release tests', '-c', 'user.email=release-tests@example.invalid', 'commit', '-m', 'Release test fixture'])
    return git(root, ['rev-parse', 'HEAD'])
  }
  return { root, commit, sha: commit() }
}

async function artifactsFixture(t) {
  const repo = await repositoryFixture(t)
  const version = '1.2.3', commit = repo.sha
  const names = releaseNames(version, commit)
  const windowsDirectory = path.join(repo.root, 'artifacts/windows'), macosDirectory = path.join(repo.root, 'artifacts/macos')
  const outputDirectory = path.join(repo.root, 'artifacts/output')
  await mkdir(windowsDirectory, { recursive: true }); await mkdir(macosDirectory, { recursive: true })
  const identity = { schemaVersion: 1, version, repository: `https://github.com/${releaseRepository}`, commit, origin: 'git', dirty: false, archive: names.source }
  const archive = async (directory, sourceIdentity = identity, { compression = '-0', environment = {} } = {}) => {
    git(repo.root, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', compression, `--prefix=Garak-Ieum-Source-${version}/`, `--output=${path.join(directory, names.source)}`, `--add-virtual-file=Garak-Ieum-Source-${version}/SOURCE_VERSION.json:${JSON.stringify(sourceIdentity)}\n`, commit], { env: { ...process.env, TZ: 'UTC', ...environment } })
  }
  await archive(windowsDirectory); await archive(macosDirectory)
  await writeFile(path.join(windowsDirectory, names.windows), Buffer.from('MZ verified Windows installer fixture'))
  await writeFile(path.join(macosDirectory, names.macos), Buffer.from('verified macOS installer fixture'))
  for (const directory of [windowsDirectory, macosDirectory]) {
    await writeFile(path.join(directory, 'SOURCE.txt'), `${version}\n${commit}\n${names.source}\nhttps://github.com/${releaseRepository}\n`)
    await writeFile(path.join(directory, 'LICENSE.txt'), 'License fixture\n')
    await writeFile(path.join(directory, 'THIRD_PARTY_NOTICES.txt'), 'Notices fixture\n')
  }
  const checksum = async (directory, installer, filename) => writeFile(path.join(directory, filename), (await Promise.all([installer, names.source].map(async name => `${await fileDigest(path.join(directory, name))}  ${name}\n`))).join(''))
  const checksums = async () => {
    await checksum(windowsDirectory, names.windows, 'SHA256SUMS.txt')
    await checksum(macosDirectory, names.macos, 'SHA256SUMS-macos-arm64.txt')
  }
  await checksums()
  const settings = { version, commit, windowsDirectory, macosDirectory, outputDirectory }
  const plan = { version, commit, config: config({ publish: true }), notes: '# Test release\n', tag: `v${version}`, publish: true }
  return { ...repo, ...settings, settings, identity, names, archive, checksums, plan }
}

function fakeGitHub(options = {}) {
  const calls = [], assets = []
  let draft
  return {
    calls,
    async get(endpoint) {
      calls.push(['get', endpoint])
      if (endpoint.startsWith('/git/ref/')) return options.existingTag || (options.tagDuringUpload && assets.length) ? { ref: endpoint } : null
      if (endpoint.startsWith('/releases?')) return options.existingDraft ? [{ tag_name: options.existingDraft, draft: true }] : []
      if (endpoint.includes('/assets?')) return options.extraAsset ? [...assets, { name: 'unexpected' }] : assets
      throw new Error(`Unexpected GET ${endpoint}`)
    },
    async post(endpoint, body) {
      calls.push(['post', endpoint, body])
      if (endpoint === '/git/refs') {
        if (options.tagDuringUpload) throw new Error('Tag already exists')
        return { ref: body.ref, object: { type: 'commit', sha: options.wrongTagCommit ? 'f'.repeat(40) : body.sha } }
      }
      draft = { id: 123, ...body }; return draft
    },
    async upload(id, expected) {
      calls.push(['upload', expected.name])
      const asset = { name: expected.name, state: 'uploaded', size: expected.size, digest: `sha256:${expected.sha256}` }
      if (options.badDigest) asset.digest = `sha256:${'0'.repeat(64)}`
      if (options.failUpload) throw new Error('Simulated interrupted upload')
      assets.push(asset)
      return asset
    },
    async patch(endpoint, body) { calls.push(['patch', endpoint, body]); return { ...draft, ...body, html_url: 'https://github.com/songchez/garak-ieum/releases/tag/v1.2.3' } },
  }
}

test('configuration enforces matching SemVer, channel, explicit publishing and local notes', async t => {
  assert.deepEqual(validateReleaseConfig(config(), '1.2.3'), config())
  for (const changes of [{ version: '01.2.3' }, { version: '1.2.3+build' }, { version: '../1' }, { channel: 'nightly' }, { publish: 'true' }, { notes: '../notes.md' }, { notes: 'releases/sub/notes.md' }, { extra: true }, { schemaVersion: 2 }]) assert.throws(() => validateReleaseConfig(config(changes), '1.2.3'))
  assert.throws(() => validateReleaseConfig(config({ channel: 'stable', version: '1.2.3-rc.1' }), '1.2.3-rc.1'))
  assert.throws(() => validateReleaseConfig(config(), '1.2.4'))
  const fixture = await repositoryFixture(t)
  await writeFile(path.join(fixture.root, 'releases/1.2.3.md'), ' ')
  await assert.rejects(readReleaseSettings(fixture.root), /empty/)
})

test('prepare updates only the selected version and preserves notes; publishing defaults off', async t => {
  const { root } = await repositoryFixture(t)
  const prepared = await prepareRelease(['--version', '2.0.0', '--channel', 'stable'], root)
  assert.equal(prepared.publish, false)
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '2.0.0')
  await writeFile(path.join(root, prepared.notes), '# Handwritten release notes\n')
  const enabled = await prepareRelease(['--', '--version', '2.0.0', '--channel', 'stable', '--publish'], root)
  assert.equal(enabled.publish, true)
  assert.equal(await readFile(path.join(root, prepared.notes), 'utf8'), '# Handwritten release notes\n')
  assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1', 'prepare must not create a commit')
  await assert.rejects(prepareRelease(['--version', '2.0.0', '--unknown'], root), /Usage/)
})

test('only a changed, enabled configuration on the main push requests publication', () => {
  const input = { config: config({ publish: true }), previousConfig: config(), eventName: 'push', ref: 'refs/heads/main', repository: releaseRepository }
  assert.equal(releaseDecision(input).publish, true)
  assert.equal(releaseDecision({ ...input, eventName: 'pull_request' }).publish, false)
  assert.equal(releaseDecision({ ...input, ref: 'refs/heads/feature' }).publish, false)
  assert.equal(releaseDecision({ ...input, config: config() }).publish, false)
  assert.equal(releaseDecision({ ...input, previousConfig: { ...input.config } }).publish, false)
  assert.equal(releaseDecision({ ...input, previousConfig: Object.fromEntries(Object.entries(input.config).reverse()) }).publish, false)
  assert.throws(() => releaseDecision({ ...input, repository: 'fork/project' }), /restricted/)
})

test('planning binds before/after to full Git history and does not repeat on normal commits', async t => {
  const fixture = await repositoryFixture(t)
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: releaseRepository }
  await writeFile(path.join(fixture.root, 'release.config.json'), JSON.stringify(config({ publish: true })))
  const requested = fixture.commit()
  let event = { before: fixture.sha, after: requested, ref: env.GITHUB_REF }
  assert.equal((await readReleasePlan({ root: fixture.root, env: { ...env, GITHUB_SHA: requested }, event })).publish, true)
  await writeFile(path.join(fixture.root, 'ordinary.txt'), 'normal change')
  const ordinary = fixture.commit()
  event = { before: requested, after: ordinary, ref: env.GITHUB_REF }
  assert.equal((await readReleasePlan({ root: fixture.root, env: { ...env, GITHUB_SHA: ordinary }, event })).publish, false)
  await assert.rejects(readReleasePlan({ root: fixture.root, env: { ...env, GITHUB_SHA: requested }, event }), /workflow commit/)
  await assert.rejects(readReleasePlan({ root: fixture.root, env, event: { ...event, before: 'f'.repeat(40) } }))
  await assert.rejects(readReleasePlan({ root: fixture.root, env, event: { ...event, ref: 'refs/heads/other' } }), /exact main push/)
})

test('checksum parser rejects missing, duplicate, traversal and unexpected version entries', () => {
  const hash = 'a'.repeat(64), name = 'installer.exe'
  assert.equal(parseChecksums(`${hash}  ${name}\r\n`, [name]).get(name), hash)
  for (const value of ['', `${hash}  ../${name}`, `${hash}  ${name}\n${hash}  ${name}`, `${hash}  other.exe`, `invalid  ${name}`]) assert.throws(() => parseChecksums(value, [name]))
})

test('staging accepts two exact builds and normalizes only sidecar line endings', async t => {
  const fixture = await artifactsFixture(t)
  await writeFile(path.join(fixture.windowsDirectory, 'LICENSE.txt'), 'License fixture\r\n')
  const assets = await stageReleaseAssets(fixture.settings)
  assert.equal(assets.length, 9)
  assert.ok(assets.some(asset => asset.name === fixture.names.windows))
  assert.ok(assets.some(asset => asset.name === fixture.names.macos))
  assert.equal(new Set(assets.map(asset => asset.name)).size, 9)
  assert.equal((await readFile(path.join(fixture.outputDirectory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').length, 8)
  await assert.rejects(stageReleaseAssets(fixture.settings), /must be empty/)
})

test('staging refuses incomplete files, changed installers and mismatched source commits', async t => {
  for (const failure of ['missing', 'checksum', 'source', 'identity', 'notices']) await t.test(failure, async child => {
    const fixture = await artifactsFixture(child)
    if (failure === 'missing') await rm(path.join(fixture.macosDirectory, fixture.names.macos))
    if (failure === 'checksum') await writeFile(path.join(fixture.windowsDirectory, fixture.names.windows), 'changed bytes')
    if (failure === 'source') { await fixture.archive(fixture.macosDirectory, { ...fixture.identity, commit: 'f'.repeat(40) }); await fixture.checksums() }
    if (failure === 'identity') {
      for (const directory of [fixture.windowsDirectory, fixture.macosDirectory]) await fixture.archive(directory, { ...fixture.identity, dirty: true })
      await fixture.checksums()
    }
    if (failure === 'notices') await writeFile(path.join(fixture.macosDirectory, 'THIRD_PARTY_NOTICES.txt'), 'Different license terms\n')
    await assert.rejects(stageReleaseAssets(fixture.settings))
    await assert.rejects(readdir(fixture.outputDirectory), { code: 'ENOENT' }, 'invalid input must not produce release staging files')
  })
})

test('ZIP identity inspection supports real Git stored and deflated archives and rejects a wrong full commit', async t => {
  const fixture = await artifactsFixture(t)
  for (const compression of ['-0', '-9']) {
    await fixture.archive(fixture.windowsDirectory, fixture.identity, { compression })
    const filename = path.join(fixture.windowsDirectory, fixture.names.source)
    assert.equal((await readSourceIdentity(filename, { version: fixture.version, commit: fixture.commit, archive: fixture.names.source })).commit, fixture.commit)
    await assert.rejects(readSourceIdentity(filename, { version: fixture.version, commit: 'f'.repeat(40), archive: fixture.names.source }), /Git commit comment/)
    const bytes = await readFile(filename)
    await writeFile(filename, bytes.subarray(0, bytes.length - 1))
    await assert.rejects(readSourceIdentity(filename, { version: fixture.version, commit: fixture.commit, archive: fixture.names.source }), /central directory/)
  }
})

test('source archive can match byte for byte despite checkout autocrlf settings', async t => {
  const fixture = await artifactsFixture(t)
  git(fixture.root, ['config', 'core.autocrlf', 'true'])
  await fixture.archive(fixture.macosDirectory)
  assert.equal(await fileDigest(path.join(fixture.windowsDirectory, fixture.names.source)), await fileDigest(path.join(fixture.macosDirectory, fixture.names.source)))
})

test('both platforms and checksums are uploaded to a draft before it can become public', async t => {
  const fixture = await artifactsFixture(t)
  const assets = await stageReleaseAssets(fixture.settings)
  const client = fakeGitHub()
  const result = await publishRelease({ client, plan: fixture.plan, assets })
  assert.equal(result.draft, false)
  const creation = client.calls.find(call => call[0] === 'post')[2]
  assert.equal(creation.draft, true)
  assert.equal(creation.target_commitish, fixture.commit)
  assert.equal(creation.prerelease, true)
  assert.equal(client.calls.filter(call => call[0] === 'upload').length, 9)
  const tagCreation = client.calls.findIndex(call => call[0] === 'post' && call[1] === '/git/refs')
  assert.ok(tagCreation > client.calls.findLastIndex(call => call[0] === 'upload'))
  assert.deepEqual(client.calls[tagCreation][2], { ref: `refs/tags/${fixture.plan.tag}`, sha: fixture.commit })
  assert.equal(client.calls.at(-1)[0], 'patch')
  assert.equal(client.calls.at(-1)[2].make_latest, 'false')
  const stable = fakeGitHub()
  await publishRelease({ client: stable, plan: { ...fixture.plan, config: config({ channel: 'stable', publish: true }) }, assets })
  assert.equal(stable.calls.at(-1)[2].make_latest, 'legacy')
})

test('existing versions are never overwritten, and interrupted or tampered uploads stay private', async t => {
  const fixture = await artifactsFixture(t)
  const assets = await stageReleaseAssets(fixture.settings)
  for (const options of [{ existingTag: true }, { existingDraft: fixture.plan.tag }, { failUpload: true }, { badDigest: true }, { extraAsset: true }, { tagDuringUpload: true }, { wrongTagCommit: true }]) {
    const client = fakeGitHub(options)
    await assert.rejects(publishRelease({ client, plan: fixture.plan, assets }))
    assert.equal(client.calls.some(call => call[0] === 'patch'), false)
    if (options.existingTag || options.existingDraft) assert.equal(client.calls.some(call => call[0] === 'post'), false)
  }
  const incomplete = fakeGitHub()
  await assert.rejects(publishRelease({ client: incomplete, plan: fixture.plan, assets: assets.slice(1) }), /complete/)
  assert.equal(incomplete.calls.length, 0)
  await writeFile(assets[0].filename, 'tampered after staging')
  const changed = fakeGitHub()
  await assert.rejects(publishRelease({ client: changed, plan: fixture.plan, assets }), /changed/)
  assert.equal(changed.calls.some(call => call[0] === 'post'), false)
})

test('GitHub transport uses fixed authenticated origins and does not follow redirects or print API bodies', async () => {
  const requests = []
  const client = githubClient({ token: 'test-only-token', fetchImpl: async (url, options) => {
    requests.push({ url, options })
    return { ok: false, status: 403, json: async () => ({ message: 'sensitive diagnostic that must not be logged' }) }
  } })
  await assert.rejects(client.get('/releases'), error => error.message.includes('HTTP 403') && !error.message.includes('sensitive diagnostic'))
  assert.equal(requests[0].url, `https://api.github.com/repos/${releaseRepository}/releases`)
  assert.equal(requests[0].options.redirect, 'error')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-only-token')
})
