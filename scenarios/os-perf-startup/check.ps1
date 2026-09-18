# Grading. CPU is sampled (5 readings, 1s apart) so a momentary spike cannot
# decide the outcome, and the runaway process is checked by name as well as by
# load: a machine can be quiet for a second while a burner is being restarted.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$faultDir = 'C:\ProgramData\OnTrak\fault'
$vbsPath = Join-Path $faultDir 'ontrak-indexer.vbs'
$ps1Path = Join-Path $faultDir 'ontrak-indexer.ps1'
$runKeyName = 'SearchIndexOptimizer'
$taskName = 'OnTrak Startup Optimizer'
$loadThreshold = 25

# --- objective: cpu-normal ---------------------------------------------------
$load = Get-OnTrakCpuLoad -Samples 5 -IntervalMs 1000

$scriptHosts = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='wscript.exe' OR Name='cscript.exe'" -ErrorAction SilentlyContinue)
$psBurners = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'ontrak-indexer' })
$burnerRunning = (($scriptHosts.Count + $psBurners.Count) -gt 0)

$loadOk = ($load -ge 0) -and ($load -lt $loadThreshold) -and (-not $burnerRunning)
$top = @(Get-OnTrakTopProcess | ForEach-Object { $_.Name + '(' + [int]$_.CPU + 's cpu)' }) -join ', '
Add-OnTrakCheck -Objective 'cpu-normal' -Passed $loadOk `
    -Detail ('cpu load=' + $load + '% (threshold <' + $loadThreshold + '%); burner process running=' + $burnerRunning + '; busiest: ' + $top)

# --- objective: persistence-removed -----------------------------------------
$runValue = Get-OnTrakRunKeyValue -Name $runKeyName
$task = @(Get-OnTrakScheduledTask -Name $taskName)
$persistenceGone = ((-not $runValue) -and ($task.Count -eq 0))
Add-OnTrakCheck -Objective 'persistence-removed' -Passed $persistenceGone `
    -Detail ('Run key present=' + [bool]$runValue + '; scheduled task present=' + ($task.Count -gt 0))

# --- objective: software-removed --------------------------------------------
$payloadGone = (-not (Test-Path $vbsPath)) -and (-not (Test-Path $ps1Path))
Add-OnTrakCheck -Objective 'software-removed' -Passed $payloadGone `
    -Detail ('program files still on disk: ' + (-not $payloadGone))

# --- objective: spooler-running ---------------------------------------------
$spoolerState = Get-OnTrakServiceState -Name 'Spooler'
$startMode = ''
try {
    $startMode = [string](Get-CimInstance -ClassName Win32_Service -Filter "Name='Spooler'" -ErrorAction Stop).StartMode
} catch { }
$spoolerOk = ($spoolerState -eq 'Running') -and ($startMode -ne 'Disabled')
Add-OnTrakCheck -Objective 'spooler-running' -Passed $spoolerOk `
    -Detail ('Spooler state=' + $spoolerState + '; startup type=' + $startMode)

Write-OnTrakReport
