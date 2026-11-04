// SPDX-License-Identifier: GPL-3.0-only
import { openAsBlob } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleasePlan, releaseRepository, releaseRoot } from './release-config.mjs'
import { fileDigest, releaseNames, stageReleaseAssets } from './release-artifacts.mjs'

export function githubClient({ token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('The publishing job requires GITHUB_TOKEN.')
  const base = `/repos/${releaseRepository}`
  async function request(method, endpoint, { body, blob, allowMissing = false } = {}) {
    // Never forward credentials to URLs supplied by release notes or API data.
    if (!endpoint.startsWith(`${base}/`) || /[?#]/.test(endpoint.split('?')[0])) throw new Error('Invalid GitHub endpoint.')
    const response = await fetchImpl(`https://${blob ? 'uploads' : 'api'}.github.com${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(blob ? 15 * 60 * 1000 : 60 * 1000),
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'garak-ieum-release',
        ...(blob ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } : body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: blob ?? (body ? JSON.stringify(body) : undefined),
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) {
      const hint = [403, 422].includes(response.status) || (response.status === 404 && method !== 'GET')
        ? ' Check repository release/tag rules and whether main changed workflow files while the installers were building. Do not bypass these rules with a personal token.' : ''
      throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} failed (HTTP ${response.status}).${hint}`)
    }
    return response.json()
  }
  return {
    get: (endpoint, options) => request('GET', `${base}${endpoint}`, options),
    post: (endpoint, body) => request('POST', `${base}${endpoint}`, { body }),
    patch: (endpoint, body) => request('PATCH', `${base}${endpoint}`, { body }),
    upload: async (releaseId, asset) => request('POST', `${base}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, { blob: await openAsBlob(asset.filename) }),
  }
}

export async function requireUnusedVersion(client, tag) {
  if (await client.get(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowMissing: true })) throw new Error(`${tag} already exists. Tags and released versions are never overwritten; prepare a new version.`)
  // List with authentication to include drafts, which the public tag endpoint
  // can omit. Refuse to proceed if the bounded scan cannot establish absence.
  for (let page = 1; page <= 20; page++) {
    const releases = await client.get(`/releases?per_page=100&page=${page}`)
    if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.')
    if (releases.some(release => release.tag_name === tag)) throw new Error(`${tag} already has a release or draft. Inspect it before retrying; existing releases are never overwritten.`)
    if (releases.length < 100) return
  }
  throw new Error('Could not exhaust the release list safely; no release was created.')
}

export function verifyUploadedAsset(actual, expected) {
  if (!actual || actual.name !== expected.name || actual.state !== 'uploaded' || actual.size !== expected.size || actual.digest !== `sha256:${expected.sha256}`) {
    throw new Error(`GitHub asset name, state, size or SHA-256 verification failed: ${expected.name}`)
  }
}

export function releaseBody(plan) {
  return `${plan.notes.trim()}\n\n---\n\n## 설치 파일과 소스\n\n- Windows 64비트: \`.exe\` 설치 마법사\n- macOS: Apple Silicon(arm64) 전용 \`.dmg\`\n- \`Garak-Ieum-Source-*.zip\`은 설치 파일과 같은 커밋의 프로젝트 소스입니다.\n- \`SHA256SUMS.txt\` 및 플랫폼별 체크섬으로 다운로드 파일을 확인할 수 있습니다.\n\n현재 설치본에는 Windows 신뢰된 배포자 서명 및 Apple Developer ID 서명·공증이 적용되어 있지 않습니다. macOS 앱은 ad-hoc 서명됩니다.\n\n버전: ${plan.version} · 채널: ${plan.config.channel}\n소스 커밋: [\`${plan.commit}\`](https://github.com/${releaseRepository}/tree/${plan.commit})\n`
}

export async function publishRelease({ client, plan, assets }) {
  if (!plan.publish || plan.tag !== `v${plan.version}` || !/^[a-f0-9]{40}$/.test(plan.commit)) throw new Error('No valid commit-based release request was supplied.')
  const required = [...Object.values(releaseNames(plan.version, plan.commit)), 'SOURCE.txt', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'SHA256SUMS.txt', 'SHA256SUMS-windows-x64.txt', 'SHA256SUMS-macos-arm64.txt'].sort()
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(required) || assets.some(asset => path.basename(asset.filename) !== asset.name)) throw new Error('Release assets must be complete and uniquely named.')
  await requireUnusedVersion(client, plan.tag)
  // Check everything again before the first write, even if a caller staged the
  // files earlier. The workflow supplies only assets from this exact run.
  for (const asset of assets) {
    const info = await lstat(asset.filename)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size || await fileDigest(asset.filename) !== asset.sha256) throw new Error(`Staged release asset changed: ${asset.name}`)
  }
  let draft = null
  try {
    draft = await client.post('/releases', {
      tag_name: plan.tag, target_commitish: plan.commit,
      name: `가락이음 ${plan.version}${plan.config.channel === 'preview' ? ' Preview' : ''}`,
      body: releaseBody(plan), draft: true, prerelease: plan.config.channel === 'preview', make_latest: 'false',
    })
    if (!Number.isSafeInteger(draft?.id) || !draft.draft || draft.tag_name !== plan.tag || draft.target_commitish !== plan.commit) throw new Error('GitHub did not create the requested draft at the exact source commit.')
    for (const asset of assets) verifyUploadedAsset(await client.upload(draft.id, asset), asset)
    const uploaded = await client.get(`/releases/${draft.id}/assets?per_page=100`)
    if (!Array.isArray(uploaded) || uploaded.length !== assets.length || new Set(uploaded.map(asset => asset.name)).size !== assets.length) throw new Error('The draft asset list is incomplete or contains unexpected assets.')
    for (const asset of assets) verifyUploadedAsset(uploaded.find(actual => actual.name === asset.name), asset)
    // Atomically reserve a NEW tag at the tested commit after asset validation.
    // POST fails if another publisher took the name; no update-ref endpoint is
    // ever called. A competing tag creation is rejected atomically instead of
    // allowing GitHub to ignore target_commitish for someone else's new tag.
    const reference = await client.post('/git/refs', { ref: `refs/tags/${plan.tag}`, sha: plan.commit })
    if (reference?.ref !== `refs/tags/${plan.tag}` || reference.object?.type !== 'commit' || reference.object.sha !== plan.commit) throw new Error('GitHub did not bind the new release tag to the tested commit.')
    const result = await client.patch(`/releases/${draft.id}`, {
      draft: false, prerelease: plan.config.channel === 'preview',
      // Legacy asks GitHub to compare SemVer, so a slower, older build cannot
      // replace a newer stable release. Previews never become latest stable.
      make_latest: plan.config.channel === 'stable' ? 'legacy' : 'false',
    })
    if (result.draft !== false || result.tag_name !== plan.tag || result.prerelease !== (plan.config.channel === 'preview')) throw new Error('GitHub did not confirm the requested publication state; inspect the release before retrying.')
    return result
  } catch (error) {
    const location = draft?.id ? ` A draft and/or new tag may remain at https://github.com/${releaseRepository}/releases. Inspect them before retrying; this script never deletes or overwrites them.` : ''
    throw new Error(`${error.message}${location}`, { cause: error })
  }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--publish') throw new Error('Publishing is available only through the release workflow, with --publish.')
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== releaseRepository) throw new Error('Only a main push in the application repository may publish a release.')
  const plan = await readReleasePlan()
  if (!plan.publish) throw new Error(`Publishing was not requested by this commit: ${plan.reason}`)
  const assets = await stageReleaseAssets({
    version: plan.version, commit: plan.commit,
    windowsDirectory: path.join(releaseRoot, 'release/incoming/windows'),
    macosDirectory: path.join(releaseRoot, 'release/incoming/macos'),
    outputDirectory: path.join(releaseRoot, 'release/publish'),
  })
  const result = await publishRelease({ client: githubClient({ token: process.env.GITHUB_TOKEN }), plan, assets })
  console.log(`Published ${plan.tag}: ${result.html_url}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
