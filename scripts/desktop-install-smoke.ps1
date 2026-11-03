Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This intentionally installs into the disposable hosted Windows runner's user account.
# It must never register file associations on a developer's normal Windows profile.
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or [string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) {
    throw 'Run the installer association check only on a GitHub-hosted Windows runner.'
}

$desktopRepository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$desktopArtifacts = Join-Path $desktopRepository 'release/desktop-smoke'
$desktopInstallDirectory = Join-Path $env:RUNNER_TEMP ('garak desktop install-' + [guid]::NewGuid().ToString('N'))
$desktopExecutable = Join-Path $desktopInstallDirectory '가락이음.exe'
$desktopProgId = 'GarakIeum.Project'
$desktopReport = [ordered]@{
    status = 'running'
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    installDirectory = $desktopInstallDirectory
    executable = $desktopExecutable
    registryScope = 'HKEY_CURRENT_USER\Software\Classes'
}
New-Item -ItemType Directory -Path $desktopArtifacts -Force | Out-Null

function Read-DefaultRegistryValue([string] $SubKey) {
    $desktopRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $desktopRegistryKey) { throw "Missing current-user registry key: $SubKey" }
    try {
        $desktopRegistryValue = $desktopRegistryKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($desktopRegistryValue -isnot [string] -or [string]::IsNullOrEmpty($desktopRegistryValue)) {
            throw "Missing registry default value: $SubKey"
        }
        return $desktopRegistryValue
    } finally { $desktopRegistryKey.Dispose() }
}

try {
    $desktopInstallers = @(Get-ChildItem -LiteralPath (Join-Path $desktopRepository 'release') -Filter 'Garak-Ieum-Setup-*-x64.exe' -File)
    if ($desktopInstallers.Count -ne 1) { throw 'Expected exactly one freshly built Windows x64 NSIS installer.' }
    $desktopReport['installer'] = $desktopInstallers[0].FullName

    # Fail before installation if this is not the clean runner account we expect.
    foreach ($desktopSubKey in @('Software\Classes\.garak', "Software\Classes\$desktopProgId")) {
        $desktopExistingKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($desktopSubKey, $false)
        if ($null -ne $desktopExistingKey) {
            $desktopExistingKey.Dispose()
            throw "Refusing to replace an existing file association: $desktopSubKey"
        }
    }

    # NSIS requires /D= to be LAST and unquoted, even when the directory contains spaces.
    # /currentuser selects HKCU without requesting elevation; /S does not auto-run the app.
    $desktopProcess = Start-Process -FilePath $desktopInstallers[0].FullName -ArgumentList "/S /currentuser /D=$desktopInstallDirectory" -WorkingDirectory $desktopRepository -PassThru
    try {
        $null = $desktopProcess.Handle # Retain the native handle for ExitCode after the process exits.
        if (-not $desktopProcess.WaitForExit(180000)) {
            try { $desktopProcess.Kill($true) } catch { Write-Warning "Could not stop timed-out test installer: $_" }
            throw 'Silent per-user installation exceeded 180 seconds.'
        }
        $desktopProcess.Refresh()
        $desktopReport['installerExitCode'] = $desktopProcess.ExitCode
        if ($desktopProcess.ExitCode -ne 0) { throw "NSIS installer exited with code $($desktopProcess.ExitCode)." }
    } finally { $desktopProcess.Dispose() }

    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) { throw 'The installer did not create the branded application executable.' }
    $desktopMcpExecutable = Join-Path $desktopInstallDirectory 'garak-mcp.exe'
    if (-not (Test-Path -LiteralPath $desktopMcpExecutable -PathType Leaf)) { throw 'The installer did not include the MCP console launcher.' }
    $desktopReport['mcpExecutable'] = $desktopMcpExecutable
    $desktopRegisteredProgId = Read-DefaultRegistryValue 'Software\Classes\.garak'
    if ($desktopRegisteredProgId -cne $desktopProgId) { throw 'The .garak extension does not resolve to the expected project ProgID.' }
    $desktopIcon = Read-DefaultRegistryValue "Software\Classes\$desktopProgId\DefaultIcon"
    $desktopExpectedIcon = '"{0}",0' -f $desktopExecutable
    if (-not [string]::Equals($desktopIcon, $desktopExpectedIcon, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The .garak icon must reference icon 0 of the installed branded executable.'
    }
    $desktopCommand = Read-DefaultRegistryValue "Software\Classes\$desktopProgId\shell\open\command"
    # The custom NSIS hook quotes both paths, including this install directory with spaces.
    $desktopExpectedCommand = '"{0}" "%1"' -f $desktopExecutable
    if (-not [string]::Equals($desktopCommand, $desktopExpectedCommand, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The .garak open command must quote both the installed executable and the %1 file argument.'
    }
    $desktopReport['progId'] = $desktopRegisteredProgId
    $desktopReport['defaultIcon'] = $desktopIcon
    $desktopReport['openCommand'] = $desktopCommand

    # The following Playwright smoke launches this installed app with its own temporary userData.
    Add-Content -LiteralPath $env:GITHUB_ENV -Value "GARAK_ELECTRON_EXECUTABLE=$desktopExecutable" -Encoding utf8
    $desktopReport['status'] = 'passed'
    Write-Host 'PASS installed .garak association, executable icon and open command'
} catch {
    $desktopReport['status'] = 'failed'
    $desktopReport['error'] = $_.Exception.Message
    throw
} finally {
    $desktopReport['finishedAt'] = [DateTimeOffset]::UtcNow.ToString('o')
    $desktopReport | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $desktopArtifacts 'installer-association.json') -Encoding utf8
}
