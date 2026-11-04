/**
 * Reads an audio source once and keeps an in-memory copy for the project.
 *
 * A File from a picker or drop, and a Blob read back from IndexedDB, only refer
 * to a file on disk. If that file is later moved, changed, synced away or cleaned
 * up, every later read — autosave, `.garak` export, pitch rendering — fails with
 * "NotReadableError: The requested file could not be read". Copying the bytes at
 * decode time makes the asset independent of where it came from.
 */
export async function ownAudioBytes(source: Blob, name: string): Promise<{ bytes: ArrayBuffer; blob: Blob }> {
  let bytes: ArrayBuffer
  try {
    bytes = await source.arrayBuffer()
  } catch {
    throw new Error(`'${name}' 파일을 읽지 못했습니다. 원본 파일이 옮겨지거나 바뀌지 않았는지 확인한 뒤 다시 가져와 주세요.`)
  }
  // The Blob constructor copies the bytes, so decoding may detach `bytes` afterwards.
  return { bytes, blob: new Blob([bytes], { type: source.type }) }
}
