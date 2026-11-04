// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { releaseRepository, validVersion } from './release-config.mjs'

export function releaseNames(version, commit) {
  if (!validVersion(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release version or source commit.')
  return {
    windows: `Garak-Ieum-Setup-${version}-x64.exe`,
    macos: `Garak-Ieum-Setup-${version}-arm64.dmg`,
    source: `Garak-Ieum-Source-${version}-${commit.slice(0, 12)}.zip`,
  }
}

export async function fileDigest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function regularFile(filename, maxBytes = Number.MAX_SAFE_INTEGER) {
  const info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > maxBytes) {
    throw new Error(`Expected a nonempty regular file: ${path.basename(filename)}`)
  }
  return info
}

export function parseChecksums(text, expectedNames) {
  const entries = new Map()
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line)
    if (!match || !expectedNames.includes(match[2]) || entries.has(match[2])) throw new Error('Checksum file has an invalid, unexpected or duplicate entry.')
    entries.set(match[2], match[1])
  }
  if (entries.size !== expectedNames.length) throw new Error('Checksum file is incomplete.')
  return entries
}

async function readBytes(handle, position, length) {
  const bytes = Buffer.alloc(length)
  const result = await handle.read(bytes, 0, length, position)
  if (result.bytesRead !== length) throw new Error('Truncated source ZIP.')
  return bytes
}

// Inspect only the small provenance entry; never extract or execute archive
// contents. Bounds, duplicate entries and CRC are checked before parsing JSON.
export async function readSourceIdentity(filename, { version, commit, archive }) {
  const size = (await regularFile(filename)).size
  const handle = await open(filename, 'r')
  try {
    const tail = await readBytes(handle, Math.max(0, size - 65557), Math.min(size, 65557))
    let end = -1
    for (let cursor = tail.length - 22; cursor >= 0; cursor--) {
      if (tail.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + tail.readUInt16LE(cursor + 20) === tail.length) { end = cursor; break }
    }
    if (end < 0) throw new Error('Source ZIP has no valid central directory.')
    const count = tail.readUInt16LE(end + 10)
    const length = tail.readUInt32LE(end + 12)
    const offset = tail.readUInt32LE(end + 16)
    const endOffset = size - tail.length + end
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count !== tail.readUInt16LE(end + 8) ||
        count === 0xffff || length > 16 * 1024 * 1024 || offset + length !== endOffset) {
      throw new Error('Unsupported or inconsistent source ZIP directory.')
    }
    if (tail.subarray(end + 22).toString('utf8') !== commit) throw new Error('Source ZIP Git commit comment does not match the release commit.')
    const directory = await readBytes(handle, offset, length)
    const wanted = `Garak-Ieum-Source-${version}/SOURCE_VERSION.json`
    let entry = null, cursor = 0
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid source ZIP entry.')
      const nameLength = directory.readUInt16LE(cursor + 28)
      const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32)
      if (next > directory.length) throw new Error('Truncated source ZIP entry.')
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      if (name === wanted) {
        if (entry) throw new Error('Duplicate source identity in ZIP.')
        entry = {
          flags: directory.readUInt16LE(cursor + 8), method: directory.readUInt16LE(cursor + 10),
          crc: directory.readUInt32LE(cursor + 16), compressed: directory.readUInt32LE(cursor + 20),
          size: directory.readUInt32LE(cursor + 24), offset: directory.readUInt32LE(cursor + 42),
        }
      }
      cursor = next
    }
    if (cursor !== directory.length || !entry) throw new Error('Source ZIP is missing its unique source identity.')
    if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 65536 || entry.compressed > 131072 || entry.offset + 30 > offset) {
      throw new Error('Unsupported source identity ZIP encoding.')
    }
    const local = await readBytes(handle, entry.offset, 30)
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== entry.method || local.readUInt16LE(6) !== entry.flags) throw new Error('Inconsistent source ZIP local entry.')
    const nameLength = local.readUInt16LE(26)
    const dataOffset = entry.offset + 30 + nameLength + local.readUInt16LE(28)
    if (dataOffset + entry.compressed > offset) throw new Error('Invalid source ZIP data bounds.')
    if ((await readBytes(handle, entry.offset + 30, nameLength)).toString('utf8') !== wanted) throw new Error('Source ZIP local entry name differs.')
    const compressed = await readBytes(handle, dataOffset, entry.compressed)
    const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 65536 })
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error('Source identity ZIP checksum failed.')
    const identity = JSON.parse(bytes.toString('utf8'))
    const expected = { schemaVersion: 1, version, repository: `https://github.com/${releaseRepository}`, commit, origin: 'git', dirty: false, archive }
    if (!identity || Object.keys(identity).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => identity[key] !== value)) {
      throw new Error('Source archive identity does not match this clean release commit.')
    }
    return identity
  } finally { await handle.close() }
}

const documents = ['SOURCE.txt', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']
const normalizedText = value => value.replace(/\r\n/g, '\n')

async function inspectPlatform(directory, installer, source, sums) {
  const expected = [installer, source, sums, ...documents].sort()
  const found = (await readdir(directory)).sort()
  if (JSON.stringify(expected) !== JSON.stringify(found)) throw new Error(`Incomplete or unexpected files in ${path.basename(directory)} artifact.`)
  for (const name of expected) await regularFile(path.join(directory, name), documents.includes(name) || name === sums ? 8 * 1024 * 1024 : Number.MAX_SAFE_INTEGER)
  const checksums = parseChecksums(await readFile(path.join(directory, sums), 'utf8'), [installer, source])
  for (const [name, expectedHash] of checksums) {
    if (await fileDigest(path.join(directory, name)) !== expectedHash) throw new Error(`SHA-256 mismatch for ${name}.`)
  }
  return checksums
}

export async function stageReleaseAssets({ version, commit, windowsDirectory, macosDirectory, outputDirectory }) {
  const names = releaseNames(version, commit)
  const windows = await inspectPlatform(windowsDirectory, names.windows, names.source, 'SHA256SUMS.txt')
  const macos = await inspectPlatform(macosDirectory, names.macos, names.source, 'SHA256SUMS-macos-arm64.txt')
  if (windows.get(names.source) !== macos.get(names.source)) throw new Error('Windows and macOS source ZIPs differ; both builds must use the exact same source.')
  await readSourceIdentity(path.join(windowsDirectory, names.source), { version, commit, archive: names.source })
  const texts = new Map()
  for (const name of documents) {
    const winText = normalizedText(await readFile(path.join(windowsDirectory, name), 'utf8'))
    const macText = normalizedText(await readFile(path.join(macosDirectory, name), 'utf8'))
    if (winText !== macText) throw new Error(`Platform license/source documents differ: ${name}`)
    texts.set(name, winText)
  }
  if (![version, commit, names.source, `https://github.com/${releaseRepository}`].every(value => texts.get('SOURCE.txt').includes(value))) throw new Error('SOURCE.txt does not identify the release source.')
  await mkdir(outputDirectory, { recursive: true })
  if ((await readdir(outputDirectory)).length) throw new Error('Release staging directory must be empty; existing files are never replaced.')
  await copyFile(path.join(windowsDirectory, names.windows), path.join(outputDirectory, names.windows))
  await copyFile(path.join(macosDirectory, names.macos), path.join(outputDirectory, names.macos))
  await copyFile(path.join(windowsDirectory, names.source), path.join(outputDirectory, names.source))
  for (const [name, content] of texts) await writeFile(path.join(outputDirectory, name), content, { flag: 'wx' })
  for (const [filename, entries] of [['SHA256SUMS-windows-x64.txt', windows], ['SHA256SUMS-macos-arm64.txt', macos]]) {
    await writeFile(path.join(outputDirectory, filename), [...entries].map(([name, hash]) => `${hash}  ${name}\n`).join(''), { flag: 'wx' })
  }
  const assets = []
  for (const name of (await readdir(outputDirectory)).sort()) {
    const filename = path.join(outputDirectory, name)
    assets.push({ name, filename, size: (await regularFile(filename)).size, sha256: await fileDigest(filename) })
  }
  const checksumName = 'SHA256SUMS.txt'
  const checksumPath = path.join(outputDirectory, checksumName)
  await writeFile(checksumPath, assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''), { flag: 'wx' })
  assets.push({ name: checksumName, filename: checksumPath, size: (await regularFile(checksumPath)).size, sha256: await fileDigest(checksumPath) })
  return assets
}
