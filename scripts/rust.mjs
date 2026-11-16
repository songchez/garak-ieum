#!/usr/bin/env node
// Daily Rust commands (docs/RUST.md): `pnpm rust:test | rust:build | rust:wasm | rust:check`.
// Runs cargo inside rust/, where rust-toolchain.toml pins the toolchain. `pnpm build` runs the
// `web-build` step below; `pnpm dev` never needs this script (the app falls back to the TypeScript
// kernels without the Rust artifact).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = path.join(root, 'rust')
const wasmTarget = 'wasm32-unknown-unknown'
const wasmBuilt = path.join(workspace, 'target', wasmTarget, 'wasm', 'garak_wasm.wasm')
export const wasmOutput = path.join(root, 'public', 'wasm', 'garak-dsp.wasm')
// Budgets for the worklet module; CI fails above them (docs/RUST.md: stage 1 is ~101 KiB raw /
// ~36 KiB gzip with every built-in effect; the architecture review allows 80 KB gzip).
const WASM_BUDGET_BYTES = 128 * 1024
const WASM_GZIP_BUDGET_BYTES = 80 * 1000

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
    'Web-only work does not need Rust: the app falls back to the TypeScript kernels.',
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

function wasm() {
  run(['build', '-p', 'garak-wasm', '--target', wasmTarget, '--profile', 'wasm'])
  mkdirSync(path.dirname(wasmOutput), { recursive: true })
  copyFileSync(wasmBuilt, wasmOutput)
  const size = statSync(wasmOutput).size
  const gzip = gzipSync(readFileSync(wasmOutput), { level: 9 }).length
  console.log(`garak-dsp.wasm: ${size} bytes (${(size / 1024).toFixed(1)} KiB, budget ${WASM_BUDGET_BYTES / 1024} KiB), gzip ${gzip} bytes (budget ${WASM_GZIP_BUDGET_BYTES}) -> ${path.relative(root, wasmOutput)}`)
  if (size > WASM_BUDGET_BYTES || gzip > WASM_GZIP_BUDGET_BYTES) {
    console.error('The WASM module exceeds its size budget (docs/RUST.md).')
    process.exit(1)
  }
}

/**
 * The step `pnpm build` runs before Vite, so every web deployment and desktop bundle ships the
 * module the app now uses by default (docs/RUST.md, stage 3):
 * - opted out (`GARAK_RUST_DSP=0` or `VITE_GARAK_RUST_DSP=0`): skipped, the app uses the TS kernels;
 * - Rust installed: builds it, and any failure fails the build;
 * - no Rust on a CI machine (GitHub workflows install it first; Cloudflare Workers Builds does not):
 *   installs the pinned toolchain with scripts/setup-rust.sh --skip-verify, then builds;
 * - no Rust on a contributor's machine: a note, and the build goes on without the module.
 */
function webBuild() {
  if (process.env.GARAK_RUST_DSP === '0' || process.env.VITE_GARAK_RUST_DSP === '0') {
    console.log('Rust DSP opted out (GARAK_RUST_DSP=0 / VITE_GARAK_RUST_DSP=0): not building garak-dsp.wasm.')
    return
  }
  const ci = !!process.env.CI && process.env.CI !== 'false'
  if (!findCargo() && ci && process.platform !== 'win32') {
    console.log('Rust is not installed on this CI machine: installing the pinned toolchain for garak-dsp.wasm (scripts/setup-rust.sh --skip-verify).')
    const setup = spawnSync('sh', [path.join(root, 'scripts', 'setup-rust.sh'), '--skip-verify'], { stdio: 'inherit' })
    if (setup.status !== 0) {
      console.error('Installing Rust failed. Set GARAK_RUST_DSP=0 to deploy without the Rust DSP module (the app then uses the TypeScript kernels).')
      process.exit(setup.status ?? 1)
    }
  }
  if (!findCargo()) {
    if (ci) {
      console.error('CI builds must include garak-dsp.wasm: install Rust first (scripts/setup-rust.ps1 -SkipVerify / setup-rust.sh --skip-verify), or set GARAK_RUST_DSP=0.')
      process.exit(1)
    }
    console.warn([
      'Rust is not installed, so this build has no public/wasm/garak-dsp.wasm (docs/RUST.md).',
      'The app still works: it falls back to the TypeScript kernels and Web Audio nodes.',
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
    run(['clippy', '-p', 'garak-dsp', '-p', 'garak-wasm', '--target', wasmTarget, '--', '-D', 'warnings'])
    break
  case 'fmt': run(['fmt', '--all']); break
  default:
    console.error('Usage: node scripts/rust.mjs <test|build|wasm|web-build|check|fmt> [cargo args]')
    process.exit(2)
}
