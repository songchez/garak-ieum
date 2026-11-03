import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const application = process.env.GARAK_MAC_APP_BUNDLE
const runnerTemporary = process.env.RUNNER_TEMP
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  || !application || !runnerTemporary || !path.resolve(application).startsWith(`${path.resolve(runnerTemporary)}${path.sep}`)) {
  console.log('Crash diagnostics require the temporary GitHub-hosted macOS installation.')
  process.exit(0)
}

const repository = fileURLToPath(new URL('../', import.meta.url))
const artifacts = path.join(repository, 'release', 'desktop-smoke')
const report = JSON.parse(await readFile(path.join(artifacts, 'report.json'), 'utf8'))
const began = Date.parse(report.startedAt)
if (!Number.isFinite(began)) throw new Error('Missing smoke start time for scoped crash diagnostics.')
const reportsDirectory = path.join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
const applicationPrefix = `${path.resolve(application).normalize('NFC')}${path.sep}`
const copied = new Set()
await mkdir(path.join(artifacts, 'macos-crashes'), { recursive: true })
// macOS can finish writing an .ips report after the process has exited. Wait
// briefly, and collect only fresh reports naming this exact temporary bundle.
for (let attempt = 0; attempt < 6; attempt++) {
  const names = await readdir(reportsDirectory).catch(() => [])
  for (const name of names) {
    if (copied.has(name) || !/\.(?:ips|crash)$/.test(name) || !/^(?:가락이음|Electron)/.test(name.normalize('NFC'))) continue
    const source = path.join(reportsDirectory, name)
    const info = await stat(source).catch(() => null)
    if (!info?.isFile() || info.mtimeMs < began - 2000 || info.size > 2 * 1024 * 1024) continue
    const content = await readFile(source, 'utf8')
    const processPath = content.match(/"procPath"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1]
    const matches = processPath
      ? JSON.parse(processPath).normalize('NFC').startsWith(applicationPrefix)
      : content.normalize('NFC').includes(applicationPrefix)
    if (!matches) continue
    const safe = content.replaceAll('Garak_Desktop_Smoke_Test_Only_000000000000000', '[test token redacted]')
    await writeFile(path.join(artifacts, 'macos-crashes', name), safe)
    copied.add(name)
  }
  if (copied.size || attempt === 5) break
  await new Promise(resolve => setTimeout(resolve, 2000))
}
await writeFile(path.join(artifacts, 'macos-crash-index.json'), `${JSON.stringify({ application, reports: [...copied] }, null, 2)}\n`)
console.log(`Collected ${copied.size} fresh crash report(s) for the temporary installed app.`)
