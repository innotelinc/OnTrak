# This scenario needs an application to break, so setup.ps1 both installs a small
# simulated CRM client and injects three faults around it:
#
#   1. config.json has a trailing comma (invalid JSON) AND a decommissioned
#      server value
#   2. the per-user override in HKCU points at localhost
#   3. a stale lock file is left behind, as a crash would
#
# The app itself is a plain PowerShell script so the scenario is self-contained:
# no MSI, no licence, no download. It is the *faults* that are the exercise.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$appDir = 'C:\Program Files\OnTrak\CrmApp'
$dataDir = 'C:\ProgramData\OnTrak\CrmApp'
$appPath = Join-Path $appDir 'CrmApp.ps1'
$configPath = Join-Path $dataDir 'config.json'
$lockPath = Join-Path $dataDir 'crmapp.lock'
$approvedServer = 'fileserver.ontrak.lab'

# ---------------------------------------------------------------- the app ----
$appSource = @'
<#
.SYNOPSIS
    Simulated CRM client used by OnTrak training scenarios.
.DESCRIPTION
    Not a real application. It reads its deployment settings, its per-user
    override and a lock file, reports what is wrong, and exits non-zero if
    anything blocks startup. -SelfTest writes the same diagnostics to
    selftest.log so support staff can work from evidence.
#>
[CmdletBinding()]
param([switch] $SelfTest)

$ErrorActionPreference = 'Continue'

$dataDir    = 'C:\ProgramData\OnTrak\CrmApp'
$configPath = Join-Path $dataDir 'config.json'
$lockPath   = Join-Path $dataDir 'crmapp.lock'
$logPath    = Join-Path $dataDir 'selftest.log'
$approved   = 'fileserver.ontrak.lab'
$problems   = New-Object System.Collections.ArrayList

function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    $line = ('{0} {1} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    Write-Host $line
    try {
        $parent = Split-Path -Parent $logPath
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Add-Content -Path $logPath -Value $line -Encoding UTF8
    } catch { }
}

Write-Log 'CrmApp starting'

# --- deployment settings ------------------------------------------------------
$config = $null
if (-not (Test-Path $configPath)) {
    $null = $problems.Add('config.json is missing from ' + $dataDir)
} else {
    try {
        $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $null = $problems.Add('config.json could not be parsed: ' + $_.Exception.Message)
    }
}

if ($config -and $config.server -ne $approved) {
    $null = $problems.Add("config.json server '" + $config.server + "' is not the approved backend")
}

# --- per-user override (takes precedence) -------------------------------------
$userServer = ''
try {
    $userServer = [string](Get-ItemProperty -Path 'HKCU:\Software\OnTrak\CrmApp' -Name 'Server' -ErrorAction Stop).Server
} catch {
    $null = $problems.Add('per-user override HKCU:\Software\OnTrak\CrmApp\Server is missing')
}
if ($userServer -and $userServer -ne $approved) {
    $null = $problems.Add("per-user override '" + $userServer + "' is not the approved backend")
}

# --- lock file ---------------------------------------------------------------
if (Test-Path $lockPath) {
    $null = $problems.Add('another instance is already running (lock file ' + $lockPath + ' present)')
}

# --- result ------------------------------------------------------------------
if ($problems.Count -gt 0) {
    foreach ($problem in $problems) { Write-Log $problem 'ERROR' }
    Write-Log ('self-test failed: ' + $problems.Count + ' problem(s)')
    if ($SelfTest) { exit 1 }
    exit 1
}

Write-Log ('connected to ' + $approved + ' (mode: ' + $config.mode + ')')
Write-Log 'SELFTEST OK'
exit 0
'@

New-OnTrakFile -Path $appPath -Content $appSource
Write-OnTrakStep ('installed simulated app at ' + $appPath)

# ------------------------------------------------------------- desktop icon --
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $env:USERPROFILE 'Desktop\CRM Client.lnk'))
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $appPath + '"'
    $shortcut.IconLocation = 'shell32.dll,21'
    $shortcut.Description = 'OnTrak simulated CRM client'
    $shortcut.Save()
} catch {
    Write-OnTrakStep 'could not create the desktop shortcut (not fatal)'
}

# ------------------------------------------------------------------ faults ----
# 1. Corrupted deployment config: a trailing comma (syntax error) plus a
#    decommissioned backend, so the student has to read the file, not just delete
#    one character.
$badConfig = @'
{
  "server": "old-crm-01.ontrak.lab",
  "port": 8443,
  "mode": "production",
}
'@
New-OnTrakFile -Path $configPath -Content $badConfig

# 2. Wrong per-user override. HKCU here belongs to the training account, which is
#    also the account the student logs in as, so they will see it.
if (-not (Test-Path 'HKCU:\Software\OnTrak\CrmApp')) {
    New-Item -Path 'HKCU:\Software\OnTrak\CrmApp' -Force | Out-Null
}
New-ItemProperty -Path 'HKCU:\Software\OnTrak\CrmApp' -Name 'Server' -Value 'localhost' `
    -PropertyType String -Force | Out-Null

# 3. Stale lock file, as an unclean shutdown would leave.
New-OnTrakFile -Path $lockPath -Content ((Get-Date -Format 's') + ' pid=4920 unclean shutdown')

# Make the failure legible in the log straight away.
New-OnTrakFile -Path (Join-Path $dataDir 'selftest.log') -Content ((Get-Date -Format 's') + ' INFO CrmApp starting')
Write-OnTrakStep 'injected: bad config.json syntax, wrong server values, stale lock file'

# The exercise is diagnosing *which* of three things is wrong, so all three have to
# be there. Each is asserted on its own signature.
Require-OnTrak 'the simulated client is installed' { Test-OnTrakFileExists -Path $appPath }
Require-OnTrak 'config.json is unparseable, as a corrupted config would be' {
    $parsed = $null
    try {
        $parsed = Get-Content -Path $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch { $parsed = $null }
    $null -eq $parsed
}
Require-OnTrak 'the per-user override points somewhere it should not' {
    (Get-ItemProperty -Path 'HKCU:\Software\OnTrak\CrmApp' -Name 'Server' -ErrorAction SilentlyContinue).Server -ne $approvedServer
}
Require-OnTrak 'the stale lock file is in place' { Test-OnTrakFileExists -Path $lockPath }

Write-OnTrakSetupOk -Note ('app=' + $appPath)
