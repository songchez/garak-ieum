import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// desktop:pack also supports the current non-Windows OS. The NSIS build requires
// Windows because its console entry point is compiled with the installed MSVC SDK.
if (process.platform !== 'win32') {
  if (process.argv.includes('--require-windows')) {
    console.error('Build the Windows installer on Windows with Visual Studio C++ build tools, or use the Windows desktop GitHub Actions workflow.')
    process.exitCode = 1
  } else {
    console.log('The MCP console launcher is only needed for Windows packaging.')
  }
} else {
  const script = fileURLToPath(new URL('./build-mcp-launcher.ps1', import.meta.url))
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) console.error('Could not start PowerShell to build the MCP console launcher.')
  process.exitCode = result.status ?? 1
}
