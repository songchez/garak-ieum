// Offline native-DSP test inputs. Uses the same TypeScript validation/wire writer
// as the UI; generated binary data belongs in the ignored build directory.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const destination = resolve(root, 'build/native/wavetable-synth/fixtures')
const server = await createServer({
  root, configFile: false, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
})
try {
  const { WAVE_PRESETS } = await server.ssrLoadModule('/src/devices/wavetable-synth/presets.ts')
  const { createDefaultWavetablePatch, getFactoryWavetableFrames, serializeWavetablePatch } = await server.ssrLoadModule('/src/devices/wavetable-synth/model.ts')
  const { encodeWavetablePatch } = await server.ssrLoadModule('/src/devices/wavetable-synth/bridge.ts')
  await mkdir(destination, { recursive: true })
  for (const preset of WAVE_PRESETS) {
    await writeFile(resolve(destination, `${preset.id}.iewave`), encodeWavetablePatch(preset.patch))
    await writeFile(resolve(destination, `${preset.id}.patch`), serializeWavetablePatch(preset.patch))
  }
  const custom = createDefaultWavetablePatch()
  custom.customBanks = [{ slot: 4, name: 'Original user spectrum', frames: getFactoryWavetableFrames(2).slice(0, 3) }]
  custom.params.osc1Bank = 4
  custom.params.osc1Position = 0.4
  custom.params.env1Hold = 0.125
  custom.params.lfo1Sync = 1
  custom.params.lfo1Division = 2
  custom.params.macro1 = 0.5
  custom.routes = [{ id: 'fixture-frame', enabled: true, source: 'lfo1', destination: 'osc1Position', amount: 0.3, bipolar: true, aux: 'macro1', curve: 0.25 }]
  custom.lfoCurves[0] = Array.from({ length: 128 }, (_, i) => (i < 64 ? i / 64 : (128 - i) / 64))
  await writeFile(resolve(destination, 'user-bank.iewave'), encodeWavetablePatch(custom))
  await writeFile(resolve(destination, 'user-bank.patch'), serializeWavetablePatch(custom))
  console.log(`Created ${WAVE_PRESETS.length + 1} validated native fixtures and JSON patches in ${destination}`)
} finally { await server.close() }
