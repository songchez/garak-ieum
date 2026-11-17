// Runs the whole C++ engine regression suite (native/tests/engine_test.cpp) with the Rust render engine inside
// RenderEngine (docs/RUST_ENGINE.md 10) and reports it.
//
//   node scripts/rust-engine-suite.mjs <garak-engine-test executable>
//
// 1. GARAK_RUST_ENGINE=1: graphs the Rust engine refuses fall back to C++. Every case must pass.
// 2. GARAK_RUST_ENGINE=strict: refused graphs throw. A case may fail only when it is listed in
//    native/tests/rust_engine_expected_failures.txt (with its blocker); a listed case that passes is reported so
//    the list can shrink. Each case also reports how many blocks the Rust graph rendered.
// 3. GARAK_RUST_ENGINE=strict with GARAK_RUST_ENGINE_HOST_INSTRUMENTS=1: the C++ built-in instruments become host
//    nodes like VST3, so every graph renders through the Rust graph (routes, monitoring, taps, frozen windows,
//    render-ahead, multi-core included). Every case must pass.
// A Markdown table goes to stdout and, on GitHub Actions, to the job summary.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const executable = process.argv[2]
if (!executable) { console.error('usage: node scripts/rust-engine-suite.mjs <garak-engine-test>'); process.exit(2) }

function run(mode, extra = {}) {
  const env = { ...process.env, GARAK_RUST_ENGINE: mode, ...extra }
  if (!extra.GARAK_RUST_ENGINE_HOST_INSTRUMENTS) delete env.GARAK_RUST_ENGINE_HOST_INSTRUMENTS
  const result = spawnSync(path.resolve(executable), [], { env, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (result.error) throw result.error
  const cases = new Map()
  for (const line of (result.stdout + '\n' + result.stderr).split(/\r?\n/)) {
    const match = /^(PASS|FAIL) (.+?) \[rust blocks: (\d+)\](?:: (.*))?$/.exec(line)
    if (match) cases.set(match[2], { pass: match[1] === 'PASS', blocks: Number(match[3]), error: match[4] ?? '' })
  }
  if (!cases.size) throw new Error(`no test results from ${executable} (GARAK_RUST_ENGINE=${mode}); exit ${result.status}\n${result.stderr}`)
  return { cases, status: result.status }
}

const expected = new Map(readFileSync(path.join(root, 'native/tests/rust_engine_expected_failures.txt'), 'utf8')
  .split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
  .map(line => { const [name, blocker] = line.split(' | '); return [name.trim(), (blocker ?? '').trim()] }))

const fallback = run('1'), strict = run('strict'), hosted = run('strict', { GARAK_RUST_ENGINE_HOST_INSTRUMENTS: '1' })
const problems = [], shrink = []
const rows = []
for (const [name, s] of strict.cases) {
  const f = fallback.cases.get(name), h = hosted.cases.get(name)
  if (!f?.pass) problems.push(`GARAK_RUST_ENGINE=1: ${name} failed: ${f?.error ?? 'missing'}`)
  if (!h?.pass) problems.push(`GARAK_RUST_ENGINE=strict + host instruments: ${name} failed: ${h?.error ?? 'missing'}`)
  const listed = expected.has(name)
  if (!s.pass && !listed) problems.push(`GARAK_RUST_ENGINE=strict: unexpected failure: ${name}: ${s.error}`)
  if (s.pass && listed) shrink.push(name)
  const strictCell = s.pass ? (s.blocks ? 'pass (Rust)' : 'pass (no engine render)') : `expected fail: ${expected.get(name) || s.error}`
  rows.push(`| ${name} | ${f?.pass ? 'pass' : 'FAIL'} (${f?.blocks ?? 0}) | ${strictCell} (${s.blocks}) | ${h?.pass ? 'pass' : 'FAIL'} (${h?.blocks ?? 0}) |`)
}
for (const name of expected.keys()) if (!strict.cases.has(name)) problems.push(`expected-failure list names an unknown case: ${name}`)

const passedRust = [...strict.cases.values()].filter(c => c.pass && c.blocks).length
const passedOther = [...strict.cases.values()].filter(c => c.pass && !c.blocks).length
const summary = [
  '### engine_test.cpp with the Rust render engine (GARAK_RUST_ENGINE)',
  '',
  `Fallback mode: ${[...fallback.cases.values()].filter(c => c.pass).length}/${fallback.cases.size} pass. ` +
    `Strict mode: ${passedRust} pass through the Rust graph, ${passedOther} pass without rendering a graph, ` +
    `${[...strict.cases.values()].filter(c => !c.pass).length} expected failures (built-in instruments not ported). ` +
    `Strict with the built-in instruments as host nodes: ${[...hosted.cases.values()].filter(c => c.pass).length}/${hosted.cases.size} pass.`,
  '',
  '| Case | GARAK_RUST_ENGINE=1 (Rust blocks) | strict (Rust blocks) | strict + host instruments (Rust blocks) |',
  '|---|---|---|---|',
  ...rows,
  '',
  ...(shrink.length ? ['Now passing in strict mode — remove from native/tests/rust_engine_expected_failures.txt:', ...shrink.map(n => `- ${n}`), ''] : []),
].join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
