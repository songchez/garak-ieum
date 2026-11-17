/**
 * A minimal ZIP writer (stored entries, no compression: WAV barely compresses) for the browser's stem export.
 * UTF-8 names (general purpose bit 11) and ZIP64 are not needed below 4 GiB, which the caller enforces.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

export interface ZipEntry { name: string; data: Uint8Array<ArrayBuffer> }

/** DOS date/time of `date` (local time, 2-second resolution). */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

export const MAX_ZIP_BYTES = 0xffffffff - 1024 * 1024

export function createZip(entries: readonly ZipEntry[], date = new Date()): Blob {
  const encoder = new TextEncoder()
  const { time, day } = dosTime(date)
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + name.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint16(8, 0, true)
    view.setUint16(10, time, true); view.setUint16(12, day, true); view.setUint32(14, crc, true)
    view.setUint32(18, entry.data.length, true); view.setUint32(22, entry.data.length, true)
    view.setUint16(26, name.length, true); view.setUint16(28, 0, true); local.set(name, 30)
    const header = new Uint8Array(46 + name.length)
    const cv = new DataView(header.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true); cv.setUint16(14, day, true); cv.setUint32(16, crc, true)
    cv.setUint32(20, entry.data.length, true); cv.setUint32(24, entry.data.length, true); cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true); header.set(name, 46)
    central.push(header)
    parts.push(local, entry.data)
    offset += local.length + entry.data.length
    if (offset > MAX_ZIP_BYTES) throw new Error('스템 묶음이 4 GB를 넘습니다. 샘플레이트·비트 깊이를 낮추거나 데스크톱 앱에서 내보내 주세요.')
  }
  const size = central.reduce((total, header) => total + header.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true)
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
