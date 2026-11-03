import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
assert.equal(process.platform, 'darwin', 'Build macOS DMGs on a Mac or the macOS CI runners.')
assert.ok(args.every(arg => ['--arm64', '--signed'].includes(arg)), 'Usage: pnpm desktop:build:mac [--arm64] [--signed]')
const arch = 'arm64'
assert.equal(process.arch, arch, 'macOS distribution supports Apple Silicon only. Use native arm64 Node.js on an Apple Silicon Mac.')
const nativeArchitecture = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim()
assert.equal(nativeArchitecture, 'arm64', 'Rosetta/cross-architecture builds are not part of this distribution workflow.')
const translated = spawnSync('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' })
assert.notEqual(translated.stdout?.trim(), '1', 'Run a native Node.js process rather than Rosetta for this architecture.')

const signed = args.includes('--signed')
if (signed) {
  // electron-builder 26 can skip notarization without credentials even when
  // notarize:true. Require a complete credential method, then verify its result.
  const groups = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ]
  let notarizationConfigured = false
  for (const names of groups) {
    if (names.some(name => Boolean(process.env[name]))) {
      assert.ok(names.every(name => Boolean(process.env[name])), `Set the complete notarization credential group: ${names.join(', ')}.`)
      notarizationConfigured = true
      break
    }
  }
  notarizationConfigured ||= Boolean(process.env.APPLE_KEYCHAIN_PROFILE)
  assert.ok(notarizationConfigured, 'Signed distribution requires notarization credentials or an APPLE_KEYCHAIN_PROFILE; credential values must stay outside the repository.')
  assert.notEqual(process.env.CSC_NAME, '-', 'An ad-hoc identity cannot produce a signed distribution.')
}

function run(command, commandArgs, environment = process.env) {
  execFileSync(command, commandArgs, { cwd: repository, stdio: 'inherit', env: environment })
}
run('pnpm', ['run', 'desktop:prepare'])
const signingOptions = signed
  ? ['--config.forceCodeSigning=true', '--config.mac.notarize=true']
  : ['--config.mac.identity=-', '--config.mac.notarize=false']
// v26 otherwise skips all signing in PR builds, including certificate-free
// ad-hoc signing. Do not forward any signing/notarization credentials to this
// preview path; the production path never enables PR signing automatically.
const previewEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CSC_|WIN_CSC_|APPLE_)/i.test(name)))
Object.assign(previewEnvironment, { CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_FOR_PULL_REQUEST: 'true' })
run('pnpm', ['exec', 'electron-builder', '--mac', 'dmg', `--${arch}`, '--publish', 'never', ...signingOptions], signed ? process.env : previewEnvironment)

const application = path.join(repository, 'release', 'mac-arm64', '가락이음.app')
await access(application)
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', application])

if (signed) {
  run('/usr/bin/xcrun', ['stapler', 'validate', application])
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', application])
  console.log(`Verified Developer ID/notarized application in the ${arch} DMG. Nothing has been published.`)
} else {
  const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', application], { encoding: 'utf8' })
  assert.equal(signature.status, 0, 'Could not inspect the preview signature.')
  assert.match(signature.stderr, /Signature=adhoc/, 'The preview must have a complete ad-hoc bundle signature.')
  console.log(`Built ${arch} DMG for development testing with ad-hoc signing. It is not Developer ID signed or notarized.`)
}
