import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, chmod } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { nativeRepository as root, nativeCache, prepareNativeDependencies } from './native-dependencies.mjs'

const args = process.argv.slice(2)
assert.ok(args.every(arg => ['--core-only', '--no-tests'].includes(arg)), 'Usage: native:build [--core-only] [--no-tests]')
const coreOnly = args.includes('--core-only')
const desktop = process.platform === 'win32' || process.platform === 'darwin'
if (process.platform === 'darwin') assert.equal(process.arch, 'arm64', 'The macOS desktop engine supports native Apple Silicon only.')
const cmake = process.env.CMAKE || 'cmake'
const ctest = process.env.CTEST || (path.isAbsolute(cmake) ? path.join(path.dirname(cmake), process.platform === 'win32' ? 'ctest.exe' : 'ctest') : 'ctest')
const { paths, archives } = await prepareNativeDependencies(cmake)
const build = path.join(root, 'build/native-work')
const output = path.join(root, 'build/native-audio')
const run = (command, values) => execFileSync(command, values, { cwd: root, stdio: 'inherit', windowsHide: true })
const options = [
  '-S', path.join(root, 'native'), '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=' + output,
  '-DGARAK_ENABLE_DEVICES=' + (desktop && !coreOnly ? 'ON' : 'OFF'),
  '-DGARAK_ENABLE_ASIO=' + (process.platform === 'win32' && !coreOnly ? 'ON' : 'OFF'),
  '-DGARAK_ENABLE_VST3=' + (coreOnly ? 'OFF' : 'ON'),
  '-DGARAK_DESKTOP_BUILD=' + (desktop && !coreOnly ? 'ON' : 'OFF'),
  '-DGARAK_BUILD_TESTS=ON',
  '-DGARAK_DEPENDENCY_CACHE=' + path.join(nativeCache, 'archives'),
  '-DGARAK_VST3_SDK_ROOT=' + paths.vst3sdk,
  '-DGARAK_MINIAUDIO_ROOT=' + paths.miniaudio,
  '-DGARAK_ASIO_SDK_ROOT=' + paths.asio,
  '-DGARAK_NLOHMANN_INCLUDE_DIR=' + path.join(paths.nlohmann, 'single_include'),
]
if (process.platform === 'darwin') options.push('-DCMAKE_OSX_ARCHITECTURES=arm64')
if (process.platform === 'win32') options.push('-A', 'x64')
run(cmake, options)
run(cmake, ['--build', build, '--config', 'Release', '--parallel', String(Math.min(4, availableParallelism()))])
if (!args.includes('--no-tests')) run(ctest, ['--test-dir', build, '-C', 'Release', '--output-on-failure'])
run(cmake, ['--install', build, '--config', 'Release'])
// The packaging boundary is explicit: only the host and notices belong in the app.
// Test plugins, SDK sources and build directories are never installed as plugins.
await mkdir(output, { recursive: true })
const executable = process.platform === 'win32' ? 'garak-audio-host.exe' : 'garak-audio-host'
await copyFile(path.join(build, 'bin', executable), path.join(output, executable))
await chmod(path.join(output, executable), 0o755)
const licenseRoot = path.join(output, 'licenses')
for (const dependency of archives) {
  for (const relative of dependency.licenseFiles ?? []) {
    const target = path.join(licenseRoot, dependency.id, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(paths[dependency.id], relative), target)
  }
}
await copyFile(path.join(root, 'native/dependencies.lock.json'), path.join(licenseRoot, 'dependencies.lock.json'))
if (process.platform === 'darwin') run('/usr/bin/codesign', ['--force', '--sign', '-', path.join(output, executable)])
const manifest = JSON.parse(await readFile(path.join(root, 'native/dependencies.lock.json'), 'utf8'))
console.log('Built native audio host with ' + (coreOnly ? 'offline core only (not distributable)' : 'VST3 and ' + (desktop ? 'platform audio devices' : 'offline Linux test support')) + '; ' + manifest.dependencies.length + ' pinned source packages.')
