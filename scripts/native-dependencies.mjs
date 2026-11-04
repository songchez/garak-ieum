import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const nativeRepository = fileURLToPath(new URL('../', import.meta.url))
export const nativeCache = path.join(nativeRepository, 'build/native-deps')
export async function nativeDependencyLock() {
  const lock = JSON.parse(await readFile(path.join(nativeRepository, 'native/dependencies.lock.json'), 'utf8'))
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.dependencies)) throw new Error('Unsupported native dependency lock')
  for (const item of lock.dependencies) {
    if (!/^[a-zA-Z0-9._-]+$/.test(item.archive) || !/^[a-f0-9]{64}$/.test(item.sha256)
      || item.directory.split('/').some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '..')) throw new Error('Invalid native dependency lock entry')
  }
  return lock
}
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(file)) hash.update(data)
  return hash.digest('hex')
}
export async function nativeArchives() {
  const lock = await nativeDependencyLock()
  const folder = path.join(nativeCache, 'archives')
  await mkdir(folder, { recursive: true })
  const results = []
  for (const dependency of lock.dependencies) {
    const file = path.join(folder, dependency.archive)
    const valid = await sha256(file).then(hash => hash === dependency.sha256, () => false)
    if (!valid) {
      const supplied = path.join(nativeRepository, 'native/dependency-sources', dependency.archive)
      if (await sha256(supplied).then(hash => hash === dependency.sha256, () => false)) await copyFile(supplied, file)
      else {
        console.log('Downloading pinned native source: ' + dependency.id + ' ' + dependency.version)
        const response = await fetch(dependency.url, { signal: AbortSignal.timeout(120_000) })
        if (!response.ok) throw new Error('Native dependency download failed: ' + dependency.id + ' HTTP ' + response.status)
        const data = Buffer.from(await response.arrayBuffer())
        if (createHash('sha256').update(data).digest('hex') !== dependency.sha256) throw new Error('Native dependency SHA256 mismatch: ' + dependency.id)
        const temporary = file + '.download'
        await writeFile(temporary, data); await rename(temporary, file)
      }
    }
    await chmod(file, 0o644)
    results.push({ ...dependency, file })
  }
  return results
}
export async function prepareNativeDependencies(cmake = process.env.CMAKE || 'cmake') {
  const archives = await nativeArchives()
  const sources = path.join(nativeCache, 'sources')
  await mkdir(sources, { recursive: true })
  const paths = {}
  for (const dependency of archives) {
    const destination = path.join(sources, dependency.directory)
    const stamp = path.join(destination, '.garak-source-sha256')
    if (await readFile(stamp, 'utf8').then(value => value === dependency.sha256, () => false)) { paths[dependency.id] = destination; continue }
    const unpack = path.join(nativeCache, 'unpack-' + dependency.id)
    await rm(unpack, { recursive: true, force: true }); await mkdir(unpack, { recursive: true })
    execFileSync(cmake, ['-E', 'tar', 'xf', dependency.file], { cwd: unpack, stdio: 'inherit', windowsHide: true })
    const extracted = dependency.archiveRoot ? path.join(unpack, dependency.archiveRoot) : unpack
    await access(extracted)
    await mkdir(path.dirname(destination), { recursive: true }); await rm(destination, { recursive: true, force: true })
    await rename(extracted, destination)
    await writeFile(stamp, dependency.sha256)
    if (extracted !== unpack) await rm(unpack, { recursive: true, force: true })
    paths[dependency.id] = destination
  }
  return { paths, archives }
}
