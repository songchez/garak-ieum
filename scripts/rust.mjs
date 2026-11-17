#!/usr/bin/env node
// Daily Rust commands (docs/RUST.md): `pnpm rust:test | rust:build | rust:wasm | rust:check`.
// Runs cargo inside rust/, where rust-toolchain.toml pins the toolchain. `pnpm build` runs the
// `web-build` step below. The web app renders only through garak-engine.wasm: `pnpm dev` without it
// shows the engine load error instead of sound, so build it once with `pnpm rust:wasm`.
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = path.join(root, 'rust')
const wasmTarget = 'wasm32-unknown-unknown'
// The unified render engine for the web (docs/RUST_ENGINE.md 5): the web's only renderer, loaded by
// the engine AudioWorklet node, the preview node, the export worker and the reverb kernel helper.
const ENGINE_PROFILE = 'wasm-engine'
const engineBuilt = path.join(workspace, 'target', wasmTarget, ENGINE_PROFILE, 'garak_engine_wasm.wasm')
export const engineOutput = path.join(root, 'public', 'wasm', 'garak-engine.wasm')
// The engine module carries the whole render engine (JSON/protocol parser, graph preparation, diff
// classification, clips, automation, tempo map) on top of every garak-dsp effect. At opt-level 3 it is
// 282 KiB raw / 113 KB gzip; the `wasm-engine` profile (opt-level "s", garak-dsp kernels kept at 3)
// makes it 258 KiB / 105 KB at the same render speed (docs/RUST_ENGINE.md 5). Instruments (G2) will
// add to it: raise the budget in the same PR, with the measured reason.
// Raised from 272 KiB / 110 KB (rust/engine-web-w2): the web host's engine-side features — metronome and
// count-in (meter map, stroke player), track-input routes with monitoring and recording taps, staged
// project updates, reverb kernel import, meters and the live event path — measured 259 -> 289 KiB raw,
// 105 -> 118 KB gzip ("z" for the engine crate saves only 6 KiB, so the profile stays).
// Raised from 304 KiB / 124 KB (rust/engine-integrate): the built-in instruments (rust/engine-instruments: the
// five synths and drum kit, sample-set zones with release zones, the vintage EP / 106 and IEUM WAVE with its
// table generator and patch schema) measured 291 -> 460 KiB raw, 119 -> 189 KB gzip. That is still far below
// the worklet's practical limit; the module is fetched once and compiled off the audio thread. The guitar rig
// insert (rust/guitar-rig: eleven module types, the rack, its catalog and hand-over) then measured 460 -> 512 KiB
// raw, 189 -> 207 KB gzip, hence 528 KiB / 212 KB.
const ENGINE_BUDGET_BYTES = 528 * 1024
const ENGINE_GZIP_BUDGET_BYTES = 212 * 1000

function findCargo() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')
  const local = path.join(home, 'bin', exe)
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: false })
  if (probe.status === 0) return 'cargo'
  if (existsSync(local)) return local
  return null
}

function cargoBinary() {
  const found = findCargo()
  if (found) return found
  console.error([
    'Rust is not installed. One command sets it up (about a minute):',
    process.platform === 'win32' ? '  powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1' : '  sh scripts/setup-rust.sh',
    'The web app renders only through garak-engine.wasm, so web work needs it too (built once, then `pnpm dev`).',
  ].join('\n'))
  process.exit(1)
}

let cargo = null
function run(args) {
  cargo ??= cargoBinary()
  console.log(`$ cargo ${args.join(' ')}`)
  const result = spawnSync(cargo, args, { cwd: workspace, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** Copies a built module to public/wasm, prints its size report and fails above its budgets. */
function publish(name, built, output, budget, gzipBudget, doc) {
  mkdirSync(path.dirname(output), { recursive: true })
  copyFileSync(built, output)
  const size = statSync(output).size
  const gzip = gzipSync(readFileSync(output), { level: 9 }).length
  console.log(`${name}: ${size} bytes (${(size / 1024).toFixed(1)} KiB, budget ${budget / 1024} KiB), gzip ${gzip} bytes (budget ${gzipBudget}) -> ${path.relative(root, output)}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${name}: ${size} bytes (${(size / 1024).toFixed(1)} KiB), gzip ${gzip} bytes (budgets ${budget / 1024} KiB / ${gzipBudget / 1000} KB)
`)
  }
  if (size > budget || gzip > gzipBudget) {
    console.error(`${name} exceeds its size budget (${doc}).`)
    process.exit(1)
  }
}

function wasm() {
  run(['build', '-p', 'garak-engine-wasm', '--target', wasmTarget, '--profile', ENGINE_PROFILE])
  publish('garak-engine.wasm', engineBuilt, engineOutput, ENGINE_BUDGET_BYTES, ENGINE_GZIP_BUDGET_BYTES, 'docs/RUST_ENGINE.md 5')
}

/**
 * The step `pnpm build` runs before Vite, so every web deployment and desktop bundle ships the
 * engine module, without which the web app cannot make sound (docs/RUST_ENGINE.md 5):
 * - Rust installed: builds it, and any failure fails the build;
 * - no Rust on a CI machine (GitHub workflows install it first; Cloudflare Workers Builds does not):
 *   installs the pinned toolchain with scripts/setup-rust.sh --skip-verify, then builds;
 * - no Rust on a contributor's machine: a warning, and the build goes on without the module (that build
 *   shows the engine load error; it is never deployable).
 */
function webBuild() {
  const ci = !!process.env.CI && process.env.CI !== 'false'
  if (!findCargo() && ci && process.platform !== 'win32') {
    console.log('Rust is not installed on this CI machine: installing the pinned toolchain for garak-engine.wasm (scripts/setup-rust.sh --skip-verify).')
    const setup = spawnSync('sh', [path.join(root, 'scripts', 'setup-rust.sh'), '--skip-verify'], { stdio: 'inherit' })
    if (setup.status !== 0) {
      console.error('Installing Rust failed: the web app cannot be deployed without garak-engine.wasm (docs/DEPLOYMENT.md).')
      process.exit(setup.status ?? 1)
    }
  }
  if (!findCargo()) {
    if (ci) {
      console.error('CI builds must include garak-engine.wasm: install Rust first (scripts/setup-rust.ps1 -SkipVerify / setup-rust.sh --skip-verify).')
      process.exit(1)
    }
    console.warn([
      'Rust is not installed, so this build has no public/wasm/garak-engine.wasm (docs/RUST.md).',
      'The web app renders only through it: this build shows the engine load error instead of sound. Do not deploy it.',
      `Release and deployment builds include it; to build it here: ${process.platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1' : 'sh scripts/setup-rust.sh'}`,
    ].join('\n'))
    return
  }
  wasm()
}

const command = process.argv[2]
const extra = process.argv.slice(3)
switch (command) {
  case 'test': run(['test', '--workspace', ...extra]); break
  // Native staticlib for the C++ host (the CMake build with -DGARAK_RUST=ON does this itself).
  case 'build': run(['build', '-p', 'garak-ffi', '--release', ...extra]); break
  case 'wasm': wasm(); break
  case 'web-build': webBuild(); break
  case 'check':
    run(['fmt', '--all', '--check'])
    run(['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'])
    run(['clippy', '-p', 'garak-dsp', '-p', 'garak-engine', '-p', 'garak-engine-wasm', '--target', wasmTarget, '--', '-D', 'warnings'])
    break
  case 'fmt': run(['fmt', '--all']); break
  default:
    console.error('Usage: node scripts/rust.mjs <test|build|wasm|web-build|check|fmt> [cargo args]')
    process.exit(2)
}
