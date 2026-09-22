# Faults:
#   1. an unwanted program that burns a full CPU core, launched by BOTH a
#      scheduled task (trigger: at startup, so it runs on every clone boot) and a
#      Run key (so the student can see it under the boot programs too)
#   2. the Print Spooler set to Disabled, which is why printing broke
#
# The burner is VBScript driven by wscript.exe when available (a distinct process
# name that is obvious in Task Manager), with a PowerShell fallback for images
# where the VBScript feature has been removed.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$faultDir = 'C:\ProgramData\OnTrak\fault'
$vbsPath = Join-Path $faultDir 'ontrak-indexer.vbs'
$ps1Path = Join-Path $faultDir 'ontrak-indexer.ps1'
$logPath = Join-Path $faultDir 'indexer.log'
$runKeyName = 'SearchIndexOptimizer'
$taskName = 'OnTrak Startup Optimizer'

New-Item -ItemType Directory -Force -Path $faultDir | Out-Null

# ------------------------------------------------------- the unwanted program --
$vbsSource = @'
' OnTrak simulated "PC Speed Booster" background optimiser.
' Deliberately benign: it spins one CPU core and writes an occasional log line.
' It makes no network connections and changes nothing outside its own log.
Dim fso, logFile, count
count = 0
Set fso = CreateObject("Scripting.FileSystemObject")
Do
  count = count + 1
  If (count Mod 4000000) = 0 Then
    Set logFile = fso.OpenTextFile("LOG_PATH", 8, True)
    logFile.WriteLine Now & " index pass " & count & " (optimising)"
    logFile.Close
  End If
Loop
'@
$vbsSource = $vbsSource.Replace('LOG_PATH', $logPath)
New-OnTrakFile -Path $vbsPath -Content $vbsSource

$ps1Source = @'
# OnTrak simulated background optimiser (PowerShell fallback).
# Deliberately benign: burns one CPU core, writes an occasional log line.
$log = 'LOG_PATH'
$count = 0
while ($true) {
    $count++
    if (($count % 4000000) -eq 0) {
        Add-Content -Path $log -Value ((Get-Date -Format 's') + ' index pass ' + $count + ' (optimising)')
    }
}
'@
$ps1Source = $ps1Source.Replace('LOG_PATH', $logPath)
New-OnTrakFile -Path $ps1Path -Content $ps1Source

# Pick the launcher. wscript.exe gives a distinct, student-visible process name.
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (Test-Path $wscript) {
    $launcher = $wscript
    $launchArgs = '"' + $vbsPath + '"'
    $payloadFile = $vbsPath
    Write-OnTrakStep 'using the VBScript launcher (wscript.exe)'
} else {
    $launcher = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $launchArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1Path + '"'
    $payloadFile = $ps1Path
    Write-OnTrakStep 'wscript.exe unavailable; falling back to the PowerShell launcher'
}

# ------------------------------------------------------------ persistence 1/2 --
Set-OnTrakRunKeyValue -Name $runKeyName -Value ('"' + $launcher + '" ' + $launchArgs) `
    -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'

# ------------------------------------------------------------ persistence 2/2 --
# At-startup trigger, running as SYSTEM: this is what re-launches the burner on
# every clone boot, even before anybody logs in.
try {
    $action = New-ScheduledTaskAction -Execute $launcher -Argument $launchArgs
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
        -Description 'Maintains the search index for PC Speed Booster' -Force | Out-Null
    Write-OnTrakStep ('registered scheduled task ' + $taskName)
} catch {
    Write-OnTrakStep ('scheduled task registration failed: ' + $_.Exception.Message)
}

# Start it now so the fault is observable in this session too.
Start-Process -FilePath $launcher -ArgumentList $launchArgs -WindowStyle Hidden -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- spooler ------
Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
Set-Service -Name Spooler -StartupType Disabled -ErrorAction SilentlyContinue

# Manifest for the grading script (what we broke and with which file).
New-OnTrakFile -Path (Join-Path $faultDir 'fault-manifest.txt') `
    -Content ('launcher=' + $launcher + "`r`npayload=" + $payloadFile + "`r`nrunkey=" + $runKeyName + "`r`ntask=" + $taskName)

Start-Sleep -Seconds 2
Write-OnTrakStep ('cpu load after fault: ' + (Get-OnTrakCpuLoad -Samples 2 -IntervalMs 500) + '%')

# Three separate faults sharing one ticket, and a partial application is not a
# smaller version of it: a machine with the runaway process but no at-startup task
# stops misbehaving after one reboot and the ticket stops making sense.
Require-OnTrak 'the optimiser payload is on disk' { Test-OnTrakFileExists -Path $payloadFile }
Require-OnTrak 'the optimiser is registered to run at logon' {
    [bool](Get-OnTrakRunKeyValue -Name $runKeyName)
}
Require-OnTrak 'the optimiser is registered to run at startup' {
    @(Get-OnTrakScheduledTask -Name $taskName).Count -gt 0
}
Require-OnTrak 'the print spooler is stopped' {
    (Get-OnTrakServiceState -Name 'Spooler') -ne 'Running'
}

Write-OnTrakSetupOk -Note ('payload=' + $payloadFile)
