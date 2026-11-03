import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Install only into the disposable hosted runner's temporary directory. This
// does not change /Applications, user projects, quarantine, Gatekeeper or TCC.
const repository = fileURLToPath(new URL('../', import.meta.url))
const artifacts = path.join(repository, 'release', 'desktop-smoke')
const report = { status: 'running', platform: process.platform, architecture: process.arch, checks: [] }
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 })
function checked(name, assertion) { assertion(); report.checks.push(name) }

try {
  assert.equal(process.platform, 'darwin', 'This installation check requires macOS.')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run installation checks in the disposable GitHub-hosted macOS workflow.')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Installation checks must not modify a developer or self-hosted Mac.')
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP must identify the hosted runner temporary directory.')
  assert.ok(process.env.GITHUB_ENV && path.isAbsolute(process.env.GITHUB_ENV), 'GITHUB_ENV is required to pass the installed executable to the smoke step.')
  assert.equal(process.arch, 'arm64', 'macOS distribution supports Apple Silicon only.')
  const { version } = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'))
  const dmg = path.join(repository, 'release', `Garak-Ieum-Setup-${version}-${process.arch}.dmg`)
  await access(dmg)
  await mkdir(artifacts, { recursive: true })
  const installRoot = await mkdtemp(path.join(await realpath(process.env.RUNNER_TEMP), 'garak macOS smoke '))
  const mountpoint = path.join(installRoot, 'Mounted DMG')
  const application = path.join(installRoot, 'Installed App', '가락이음.app')
  await mkdir(mountpoint)
  await mkdir(path.dirname(application))
  let mounted = false
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg])
    mounted = true
    const source = path.join(mountpoint, '가락이음.app')
    await access(source)
    run('/usr/bin/ditto', [source, application])
  } finally {
    if (mounted) run('/usr/bin/hdiutil', ['detach', mountpoint])
  }
  report.checks.push('DMG mounted read-only, app copied to a path with spaces, and image detached')

  const contents = path.join(application, 'Contents')
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]))
  checked('bundle identity and version', () => {
    assert.equal(info.CFBundleIdentifier, 'com.garakieum.desktop')
    assert.equal(info.CFBundleShortVersionString, version)
    assert.equal(info.CFBundleExecutable, '가락이음')
    assert.equal(info.CFBundlePackageType, 'APPL')
    assert.ok(info.NSMicrophoneUsageDescription?.includes('녹음'), 'A microphone recording purpose must be provided.')
  })
  const executable = path.join(contents, 'MacOS', info.CFBundleExecutable)
  await access(executable)
  const icon = await readFile(path.join(contents, 'Resources', info.CFBundleIconFile))
  checked('branded app icon', () => assert.equal(icon.subarray(0, 4).toString('ascii'), 'icns'))
  checked('.garak document type, UTI, and icon', () => {
    const document = info.CFBundleDocumentTypes?.find(type => type.LSItemContentTypes?.includes('com.garakieum.project'))
    assert.ok(document, 'The .garak UTI is not registered as a document type.')
    assert.equal(document.CFBundleTypeRole, 'Editor')
    assert.ok(document.CFBundleTypeExtensions?.includes('garak'))
    assert.equal(document.CFBundleTypeIconFile, info.CFBundleIconFile)
    const uti = info.UTExportedTypeDeclarations?.find(type => type.UTTypeIdentifier === 'com.garakieum.project')
    assert.ok(uti?.UTTypeConformsTo?.includes('public.json'))
    assert.ok(uti?.UTTypeTagSpecification?.['public.filename-extension']?.includes('garak'))
    assert.equal(uti?.UTTypeIconFile, info.CFBundleIconFile)
  })
  const binaryArchitectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/)
  checked('native executable architecture', () => assert.deepEqual(binaryArchitectures, ['arm64']))
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', application])
  const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', application], { encoding: 'utf8' })
  checked('ad-hoc signature integrity (not Developer ID or notarization)', () => {
    assert.equal(signature.status, 0)
    assert.match(signature.stderr, /Signature=adhoc/)
    assert.ok(!signature.stderr.includes('Authority=Developer ID Application:'))
  })
  const entitlements = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', application])
  checked('audio and Electron runtime entitlements', () => {
    for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.device.audio-input']) {
      assert.ok(entitlements.includes(`<key>${key}</key>`), `Missing entitlement: ${key}`)
    }
  })
  const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  run(launchServices, ['-f', application])
  report.checks.push('temporary app registered with Launch Services without changing default associations')
  await appendFile(process.env.GITHUB_ENV, `GARAK_ELECTRON_EXECUTABLE=${executable}\nGARAK_MAC_APP_BUNDLE=${application}\n`)
  Object.assign(report, {
    status: 'passed', version, dmg: path.basename(dmg), application, executable,
    minimumSystemVersion: info.LSMinimumSystemVersion ?? null,
    signature: 'ad-hoc', developerIDSigned: false, notarized: false,
    physicalMicrophoneTested: false, physicalAudioDevicesTested: false,
  })
  console.log(`PASS macOS ${process.arch} DMG install, icon, .garak UTI, architecture, and ad-hoc signature validation`)
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  process.exitCode = 1
  console.error(`macOS installation check failed: ${error}`)
} finally {
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, 'macos-install.json'), `${JSON.stringify(report, null, 2)}\n`)
}
