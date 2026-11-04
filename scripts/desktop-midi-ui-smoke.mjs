import assert from 'node:assert/strict'

const variable = value => {
  const bytes = [value & 127]
  while ((value >>= 7)) bytes.unshift((value & 127) | 128)
  return bytes
}
const event = (delta, ...bytes) => [...variable(delta), ...bytes]
const name = text => [0, 0xff, 3, ...variable(Buffer.byteLength(text)), ...Buffer.from(text)]
const end = [0, 0xff, 0x2f, 0]
const chunk = (id, bytes) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length)
  return Buffer.concat([Buffer.from(id), length, Buffer.from(bytes)])
}
const smf = (format, tracks) => {
  const header = Buffer.alloc(6); header.writeUInt16BE(format); header.writeUInt16BE(tracks.length, 2); header.writeUInt16BE(480, 4)
  return Buffer.concat([chunk('MThd', header), ...tracks.map(track => chunk('MTrk', track))])
}
const multipart = () => smf(1, [
  [...name('MIDI QA conductor'), ...event(0, 0xff, 0x51, 3, 6, 0x1a, 0x80), ...event(0, 0xff, 0x58, 4, 3, 2, 24, 8), ...end],
  [...name('MIDI QA Keys'), ...event(0, 0xc0, 0), ...event(0, 0x90, 60, 100), ...event(960, 0x80, 60, 0), ...event(0, 0x90, 64, 90), ...event(960, 0x80, 64, 0), ...end],
  [...name('MIDI QA Drums'), ...event(0, 0x99, 36, 110), ...event(120, 0x89, 36, 0), ...event(360, 0x99, 38, 105), ...event(120, 0x89, 38, 0), ...end],
])
const singlepart = () => smf(0, [[...name('MIDI QA WAVE'), ...event(0, 0x90, 48, 105), ...event(960, 0x90, 48, 0), ...event(0, 0x90, 55, 100), ...event(960, 0x80, 55, 0), ...end]])

/** Read the actual autosave in both packaged garak:// and development origins. */
async function savedProject(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('noct-studio')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction(['project-bundles', 'project-summaries'], 'readonly')
      let project = null
      const latest = transaction.objectStore('project-summaries').index('updatedAt').openCursor(null, 'prev')
      latest.onsuccess = () => {
        if (!latest.result) return
        const request = transaction.objectStore('project-bundles').get(latest.result.value.id)
        request.onsuccess = () => { project = request.result?.project ?? null }
      }
      transaction.oncomplete = () => { database.close(); resolve(project) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
}

async function savedWhen(page, description, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const project = await savedProject(page)
    if (project && predicate(project)) return project
    await page.waitForTimeout(80)
  }
  throw new Error(`Timed out waiting for persisted ${description}`)
}

/** Actual File input/DragEvent → app import → saved notes → native C++ playback. */
export async function verifyMidiImportUI(page, { waveTrackId, screenshot }) {
  await page.locator('.save-indicator.saved').waitFor()
  const before = await savedWhen(page, 'WAVE source track', project => project.tracks.some(track => track.id === waveTrackId))
  const originalWave = before.tracks.find(track => track.id === waveTrackId)
  const count = before.tracks.length
  const input = page.locator('input[aria-label="오디오·MIDI 파일"]')
  assert.match(await input.getAttribute('accept'), /\.mid,\.midi/)

  await input.setInputFiles({ name: 'multi-channel.mid', mimeType: 'audio/midi', buffer: multipart() })
  const imported = await savedWhen(page, 'multipart MIDI import', project => project.tracks.length === count + 2 && project.tracks.some(track => track.name === 'MIDI QA Keys'))
  assert.equal(imported.bpm, before.bpm, 'MIDI import changed an existing project tempo')
  assert.deepEqual(imported.timeSignature, before.timeSignature, 'MIDI import changed an existing project meter')
  const keys = imported.tracks.find(track => track.name === 'MIDI QA Keys'), drums = imported.tracks.find(track => track.name === 'MIDI QA Drums')
  assert.equal(keys.kind, 'instrument'); assert.equal(drums.instrument, 'drums')
  assert.deepEqual(keys.clips[0].notes.map(({ pitch, start, duration, velocity }) => ({ pitch, start, duration, velocity })), [
    { pitch: 60, start: 0, duration: 2, velocity: 100 / 127 }, { pitch: 64, start: 2, duration: 2, velocity: 90 / 127 },
  ])
  assert.deepEqual(drums.clips[0].notes.map(note => note.pitch), [36, 38])
  assert.equal(await page.locator('.timeline-clip.midi').count(), 2)
  assert.equal(await page.locator(`.track-row[data-track-row-id="${keys.id}"] .clip-preview rect`).count(), 2)

  const transport = page.getByRole('group', { name: '재생 및 편집', exact: true })
  await transport.getByRole('button', { name: /^실행 취소: 오디오·MIDI 가져오기/ }).click()
  await savedWhen(page, 'MIDI undo', project => project.tracks.length === count)
  await transport.getByRole('button', { name: /^다시 실행: 오디오·MIDI 가져오기/ }).click()
  const redone = await savedWhen(page, 'MIDI redo', project => project.tracks.length === count + 2)
  assert.deepEqual(redone, imported, 'Redo did not restore the exact imported note IDs and timing')

  // A valid first file must not partially commit if the second file is corrupt.
  await input.setInputFiles([
    { name: 'valid-before-broken.mid', mimeType: 'audio/midi', buffer: singlepart() },
    { name: 'broken.mid', mimeType: 'audio/midi', buffer: Buffer.from('MThd truncated') },
  ])
  await page.locator('.toast').filter({ hasText: '파일을 가져오지 못했습니다' }).waitFor()
  assert.equal(await page.locator('.track-header[data-track-id]').count(), count + 2)
  assert.deepEqual(await savedProject(page), redone, 'A malformed MIDI batch partially changed the project')

  const lane = page.locator(`.track-row[data-track-row-id="${waveTrackId}"] .track-lane`)
  await lane.scrollIntoViewIfNeeded()
  const bounds = await lane.boundingBox()
  assert.ok(bounds)
  const transfer = await page.evaluateHandle(bytes => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], 'wave-drop.mid', { type: 'audio/midi' }))
    return data
  }, [...singlepart()])
  try {
    const drop = { dataTransfer: transfer, clientX: bounds.x + 4, clientY: bounds.y + bounds.height / 2 }
    await lane.dispatchEvent('dragover', drop)
    await lane.dispatchEvent('drop', drop)
  } finally { await transfer.dispose() }
  const dropped = await savedWhen(page, 'MIDI drop onto WAVE', project => project.tracks.find(track => track.id === waveTrackId)?.clips.some(clip => clip.name === 'MIDI QA WAVE'))
  const wave = dropped.tracks.find(track => track.id === waveTrackId), clip = wave.clips.find(clip => clip.name === 'MIDI QA WAVE')
  assert.equal(dropped.tracks.length, count + 2, 'Dropping a single part created an extra track')
  assert.equal(dropped.bpm, before.bpm)
  assert.equal(wave.instrument, 'wavetable')
  assert.deepEqual(wave.instrumentParams, originalWave.instrumentParams)
  assert.deepEqual(wave.instrumentState, originalWave.instrumentState)
  assert.equal(clip.startBeat, 0)
  assert.deepEqual(clip.notes.map(note => note.pitch), [48, 55])
  assert.deepEqual(clip.notes.map(note => [note.start, note.duration]), [[0, 2], [2, 2]])

  await transport.getByRole('button', { name: '정지', exact: true }).click()
  await transport.getByRole('button', { name: '재생', exact: true }).click()
  await page.waitForFunction(async ids => {
    const state = await window.garakDesktop.audio.request('engine.snapshot')
    return state.testClock === true && state.device?.backend === 'test' && state.playing && ids.every(id => state.levels?.[id] > .002)
  }, [waveTrackId, keys.id])
  const audible = await page.evaluate(() => window.garakDesktop.audio.request('engine.snapshot'))
  assert.ok(audible.masterLevel > .002, 'Imported MIDI did not reach the native mixer')
  await screenshot?.('qa-native-midi-audible.png')
  await transport.getByRole('button', { name: '정지', exact: true }).click()
  await page.waitForFunction(async () => {
    const state = await window.garakDesktop.audio.request('engine.snapshot')
    return !state.playing && state.masterLevel < .0001
  })
  return { filePicker: true, multipartTracks: 2, noteCount: 6, channel10Drums: true, undoRedo: true, malformedBatchAtomic: true,
    waveDropPreservesPatch: true, existingTempoPreserved: true, nativePlaybackAudible: true }
}
