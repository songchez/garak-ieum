Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Build the MCP console launcher on Windows with the installed Visual Studio C++ tools.' }

$mcpRepository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$mcpSource = Join-Path $mcpRepository 'desktop/mcp-launcher.cpp'
$mcpOutput = Join-Path $mcpRepository 'build/native'
$mcpExecutable = Join-Path $mcpOutput 'garak-mcp.exe'
$mcpVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $mcpVsWhere -PathType Leaf)) { throw 'Visual Studio Installer vswhere.exe was not found; no tools will be downloaded automatically.' }
$mcpInstallations = @(& $mcpVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($LASTEXITCODE -ne 0 -or $mcpInstallations.Count -ne 1) { throw 'An installed Visual Studio x64 C++ toolchain is required.' }
$mcpVsDevCmd = Join-Path ($mcpInstallations[0].Trim()) 'Common7/Tools/VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $mcpVsDevCmd -PathType Leaf)) { throw 'The installed Visual Studio developer command script is missing.' }
New-Item -ItemType Directory -Path $mcpOutput -Force | Out-Null

# VsDevCmd sets INCLUDE/LIB/PATH only inside this child cmd.exe. /MT avoids a separate CRT install.
# Paths stay quoted in the Unicode command line, including repository paths containing spaces.
$mcpBuildCommand = 'call "{0}" -no_logo -arch=x64 -host_arch=x64 && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /MT /utf-8 /DUNICODE /D_UNICODE "{1}" /Fogarak-mcp.obj /Fegarak-mcp.exe /link /SUBSYSTEM:CONSOLE /MACHINE:X64 /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT' -f $mcpVsDevCmd, $mcpSource
Push-Location -LiteralPath $mcpOutput
try {
    & $env:ComSpec /d /s /c $mcpBuildCommand
    if ($LASTEXITCODE -ne 0) { throw "The MCP console launcher build failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

# Check the produced PE, so a wrong architecture or GUI subsystem cannot silently pass packaging.
$mcpImage = [IO.File]::ReadAllBytes($mcpExecutable)
if ($mcpImage.Length -lt 256 -or $mcpImage[0] -ne 0x4d -or $mcpImage[1] -ne 0x5a) { throw 'The launcher output is not a Windows PE executable.' }
$mcpPeOffset = [BitConverter]::ToInt32($mcpImage, 0x3c)
if ($mcpPeOffset -lt 0 -or $mcpPeOffset -gt $mcpImage.Length - 94 -or [BitConverter]::ToUInt32($mcpImage, $mcpPeOffset) -ne 0x00004550) {
    throw 'The launcher output has an invalid PE header.'
}
if ([BitConverter]::ToUInt16($mcpImage, $mcpPeOffset + 4) -ne 0x8664 -or
    [BitConverter]::ToUInt16($mcpImage, $mcpPeOffset + 24) -ne 0x020b -or
    [BitConverter]::ToUInt16($mcpImage, $mcpPeOffset + 24 + 68) -ne 3) {
    throw 'The launcher must be a Windows x64 console-subsystem executable.'
}
Write-Host "Built Windows x64 MCP console launcher: $mcpExecutable"
