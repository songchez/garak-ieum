// Usage: node cdp-eval.mjs <url> <expression-file.js> [timeoutMs]
// Launches headless Edge with remote debugging, evaluates an async expression, prints its result.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, exprFile, timeoutArg] = process.argv.slice(2)
const timeout = Number(timeoutArg ?? 60000)
const expr = readFileSync(exprFile, 'utf8')
const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), 'edge-cdp-'))
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'],
  { stdio: 'ignore' })
const die = (code = 0) => { try { edge.kill() } catch {} process.exit(code) }
process.on('SIGINT', () => die(1))
let list
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 200))
  try { list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension')); if (list.length) break } catch {}
}
if (!list?.length) { console.error('edge did not start'); die(1) }
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
const events = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method) events.push(m)
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
const loaded = new Promise(r => { const prev = ws.onmessage; ws.onmessage = e => { prev(e); if (JSON.parse(e.data).method === 'Page.loadEventFired') r() } })
await send('Page.navigate', { url })
await Promise.race([loaded, new Promise(r => setTimeout(r, 10000))])
await new Promise(r => setTimeout(r, 500))
const result = await Promise.race([
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout }),
  new Promise(r => setTimeout(() => r({ timeout: true }), timeout + 2000)),
])
const consoleLines = events.filter(e => e.method === 'Runtime.consoleAPICalled').map(e => `[console.${e.params.type}] ${e.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`)
const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => `[exception] ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`)
const logs = events.filter(e => e.method === 'Log.entryAdded').map(e => `[${e.params.entry.level}] ${e.params.entry.text}`)
console.log(JSON.stringify({ result: result.timeout ? 'TIMEOUT' : (result.result?.result?.value ?? result.result?.exceptionDetails?.text ?? result), console: consoleLines, exceptions, logs }, null, 1))
die(0)
