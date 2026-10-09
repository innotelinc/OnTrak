# Grading. Deliberately does not look for "Ethernet 2": the objective is that no
# adapter is left disabled or unhealthy, so re-enabling, reinstalling the driver
# or removing and rescanning all count as correct.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$notesPath = Join-Path $env:USERPROFILE 'Desktop\ontrak-notes.txt'

# --- objective: nic-device-ok ------------------------------------------------
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Not Present' })
$disabled = @($adapters | Where-Object { $_.Status -eq 'Disabled' })
$unhealthy = @()
foreach ($adapter in $adapters) {
    $device = Get-PnpDevice -InstanceId $adapter.PnpDeviceID -ErrorAction SilentlyContinue
    if ($device -and $device.Problem -ne 'CM_PROB_NONE') {
        $unhealthy += ($adapter.Name + '=' + $device.Problem)
    }
}
$adaptersText = (($adapters | ForEach-Object { $_.Name + '/' + $_.Status }) -join ', ')
$deviceOk = (($adapters.Count -ge 2) -and ($disabled.Count -eq 0) -and ($unhealthy.Count -eq 0))
Add-OnTrakCheck -Objective 'nic-device-ok' -Passed $deviceOk `
    -Detail ('adapters: ' + $adaptersText + '; disabled=' + $disabled.Count + '; problem codes: ' + (($unhealthy -join ', ') -replace '^$', 'none'))

# --- objective: nic-link-up --------------------------------------------------
$up = @($adapters | Where-Object { $_.Status -eq 'Up' })
$linkOk = ($up.Count -ge 2)
Add-OnTrakCheck -Objective 'nic-link-up' -Passed $linkOk `
    -Detail ('adapters with link up: ' + $up.Count + ' of ' + $adapters.Count + ' (' + (($up | ForEach-Object { $_.Name }) -join ', ') + ')')

# --- objective: cause-documented --------------------------------------------
$evidence = Test-OnTrakReportField -Path $notesPath -Field 'Evidence' -MinLength 15
$action = Test-OnTrakReportField -Path $notesPath -Field 'Action' -MinLength 15
Add-OnTrakCheck -Objective 'cause-documented' -Passed ($evidence -and $action) `
    -Detail ('notes at ' + $notesPath + '; Evidence line: ' + $evidence + '; Action line: ' + $action)

Write-OnTrakReport
