# Grading. Grades the four faults independently so partial credit is meaningful,
# and runs the app's own self-test as the end-to-end proof.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$appPath = 'C:\Program Files\OnTrak\CrmApp\CrmApp.ps1'
$dataDir = 'C:\ProgramData\OnTrak\CrmApp'
$configPath = Join-Path $dataDir 'config.json'
$lockPath = Join-Path $dataDir 'crmapp.lock'
$logPath = Join-Path $dataDir 'selftest.log'
$approved = 'fileserver.ontrak.lab'

# --- objective: config-valid -------------------------------------------------
$configOk = $false
$configDetail = 'config.json missing'
if (Test-Path $configPath) {
    try {
        $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $server = [string]$config.server
        $configOk = ($server -eq $approved)
        $configDetail = 'config.json parses; server=' + $server
    } catch {
        $configDetail = 'config.json still does not parse: ' + $_.Exception.Message
    }
}
Add-OnTrakCheck -Objective 'config-valid' -Passed $configOk -Detail $configDetail

# --- objective: settings-correct ---------------------------------------------
$userServer = ''
try {
    $userServer = [string](Get-ItemProperty -Path 'HKCU:\Software\OnTrak\CrmApp' -Name 'Server' -ErrorAction Stop).Server
} catch { }
$settingsOk = ($userServer -eq $approved)
Add-OnTrakCheck -Objective 'settings-correct' -Passed $settingsOk `
    -Detail ("HKCU:\Software\OnTrak\CrmApp\Server = '" + $userServer + "' (approved: " + $approved + ")")

# --- objective: lock-cleared -------------------------------------------------
$lockGone = -not (Test-Path $lockPath)
Add-OnTrakCheck -Objective 'lock-cleared' -Passed $lockGone `
    -Detail ('stale lock file present: ' + (-not $lockGone))

# --- objective: app-selftest -------------------------------------------------
# Run the app in its own process: it calls exit, which would terminate this
# grading script if invoked in-process. Delete the previous log first so a stale
# success cannot be graded.
$selfTestOk = $false
$selfTestDetail = 'self-test not run'
if (Test-Path $logPath) { Remove-Item -Path $logPath -Force -ErrorAction SilentlyContinue }
try {
    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $appPath + '"'), '-SelfTest') `
        -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
    $exitCode = $proc.ExitCode
    $logTail = ''
    if (Test-Path $logPath) {
        $logTail = (Get-Content -Path $logPath -Tail 3 -ErrorAction SilentlyContinue) -join ' | '
    }
    $selfTestOk = ($exitCode -eq 0) -and ($logTail -match 'SELFTEST OK')
    $selfTestDetail = 'exit code ' + $exitCode + '; log: ' + $logTail
} catch {
    $selfTestDetail = 'could not run the self-test: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'app-selftest' -Passed $selfTestOk -Detail $selfTestDetail

Write-OnTrakReport
