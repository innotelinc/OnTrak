# Fault: the additional network adapter (eth1, declared under instance_devices in
# scenario.yaml) is disabled at the device level, which is exactly what Device
# Manager shows as a yellow warning triangle and what a real bad driver
# installation looks like to a support technician.
#
# Reversible by: Device Manager -> right-click -> Enable device
#                Enable-PnpDevice -InstanceId <id> -Confirm:$false

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$faultDir = 'C:\ProgramData\OnTrak\fault'
New-Item -ItemType Directory -Force -Path $faultDir | Out-Null

# Pick the adapter to break. Windows names devices in detection order, so the
# first adapter is the primary one; prefer an explicit "Ethernet 2" name when it
# exists and fall back to the highest interface index.
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -ne 'Not Present' } |
    Sort-Object -Property ifIndex)
Write-OnTrakStep ('network adapters present: ' + (($adapters | ForEach-Object { $_.Name }) -join ', '))

if ($adapters.Count -lt 2) {
    throw ('this scenario needs two network adapters, found ' + $adapters.Count +
        '. Check instance_devices in scenario.yaml and rebuild the template.')
}

$target = $adapters | Where-Object { $_.Name -eq 'Ethernet 2' } | Select-Object -First 1
if (-not $target) { $target = $adapters[-1] }

Write-OnTrakStep ('disabling device ' + $target.Name + ' (' + $target.InterfaceDescription + ')')
try {
    Disable-PnpDevice -InstanceId $target.PnpDeviceID -Confirm:$false -ErrorAction Stop
} catch {
    Write-OnTrakStep ('Disable-PnpDevice failed: ' + $_.Exception.Message)
    throw
}

# Record what was broken: the grading script reports names from this manifest so
# the feedback is specific rather than "an adapter".
New-OnTrakFile -Path (Join-Path $faultDir 'hw-manifest.txt') `
    -Content ('adapter=' + $target.Name + "`r`ninstanceid=" + $target.PnpDeviceID)

Start-Sleep -Seconds 2
$status = (Get-NetAdapter -Name $target.Name -ErrorAction SilentlyContinue).Status
Write-OnTrakStep ('adapter status after fault: ' + $status + ' (expected Disabled)')

# The fault is what Device Manager shows, so assert on the device state rather than
# on Disable-PnpDevice having returned without throwing.
Require-OnTrak ('adapter ' + $target.Name + ' is disabled') {
    (Get-NetAdapter -Name $target.Name -ErrorAction SilentlyContinue).Status -eq 'Disabled'
}
# Grading names the device from this manifest, so a build that skipped it would hand
# the student generic feedback about "an adapter".
Require-OnTrak 'the manifest grading reads was written' {
    Test-OnTrakFileExists -Path (Join-Path $faultDir 'hw-manifest.txt')
}

Write-OnTrakSetupOk -Note ('disabled=' + $target.Name)
