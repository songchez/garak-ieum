# One-command Rust setup for Windows (docs/RUST.md).
#   powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1 [-SkipVerify]
#
# 1. Installs rustup from static.rust-lang.org if missing (no admin rights, no Visual Studio).
# 2. Without Visual Studio C++ tools, makes x86_64-pc-windows-gnu the default host: Rust's GNU
#    toolchain ships its own MinGW linker, so nothing else is needed. With VS, MSVC is kept.
# 3. Installs exactly the toolchain pinned in rust/rust-toolchain.toml (minimal profile,
#    rustfmt, clippy, wasm32 target) and verifies with `cargo test`.
# Safe to re-run.
[CmdletBinding()]
param([switch]$SkipVerify)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$workspace = Join-Path $repo 'rust'
$cargoBin = Join-Path $(if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $HOME '.cargo' }) 'bin'
if (-not (($env:Path -split ';') -contains $cargoBin)) { $env:Path = "$cargoBin;$env:Path" }

function Test-Command($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function Test-MsvcTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { return $false }
  $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return [bool]$path
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
$hasMsvc = Test-MsvcTools
$hostTriple = if ($hasMsvc) { "$arch-pc-windows-msvc" } else { "$arch-pc-windows-gnu" }
if (-not $hasMsvc -and $arch -eq 'aarch64') {
  # The windows-gnu target has no self-contained ARM64 linker; gnullvm needs an external clang.
  Write-Warning 'ARM64 Windows without Visual Studio C++ tools: install "Build Tools for Visual Studio" (C++ workload) and re-run.'
  $hostTriple = 'aarch64-pc-windows-msvc'
}

if (-not (Test-Command 'rustup')) {
  Write-Host "Installing rustup ($hostTriple host) from static.rust-lang.org ..."
  $installer = Join-Path ([IO.Path]::GetTempPath()) "rustup-init-$PID.exe"
  $url = "https://static.rust-lang.org/rustup/dist/$arch-pc-windows-msvc/rustup-init.exe"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
  try {
    # No default toolchain: the pinned one is installed below. Minimal profile keeps it small.
    & $installer -y --default-toolchain none --profile minimal --default-host $hostTriple
    if ($LASTEXITCODE -ne 0) { throw "rustup-init failed ($LASTEXITCODE)" }
  } finally { Remove-Item $installer -Force -ErrorAction SilentlyContinue }
} elseif (-not $hasMsvc) {
  $current = (& rustup show 2>$null | Select-String 'Default host:' | ForEach-Object { ($_ -split ':\s*')[1].Trim() })
  if ($current -like '*-msvc') {
    Write-Host "Visual Studio C++ tools not found: switching rustup's default host to $hostTriple."
    Write-Host '(Only affects toolchains named without a host, like the pinned one. Undo: rustup set default-host x86_64-pc-windows-msvc)'
    & rustup set default-host $hostTriple
  }
}

Push-Location $workspace
try {
  Write-Host 'Installing the pinned toolchain from rust/rust-toolchain.toml ...'
  & rustup toolchain install
  if ($LASTEXITCODE -ne 0) { & rustup show active-toolchain; if ($LASTEXITCODE -ne 0) { throw 'toolchain install failed' } }
  & rustc --version
  & cargo --version
  $targets = & rustup target list --installed
  if (-not ($targets -contains 'wasm32-unknown-unknown')) { & rustup target add wasm32-unknown-unknown }
  if (-not $SkipVerify) {
    Write-Host 'Verifying: cargo test --workspace'
    & cargo test --workspace --quiet
    if ($LASTEXITCODE -ne 0) { throw 'cargo test failed; see docs/RUST.md troubleshooting.' }
  }
} finally { Pop-Location }

Write-Host ''
Write-Host 'Rust is ready. Daily commands: pnpm rust:test | pnpm rust:wasm | pnpm rust:check'
Write-Host "Open a new terminal (or add $cargoBin to PATH) to use cargo directly."
