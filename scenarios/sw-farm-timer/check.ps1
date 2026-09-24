# Grading for sw-farm-timer: the farm's own services are back and stay back —
# today's state and the startup type are graded separately on purpose, since
# "I started them" leaves Monday's restart to repeat the ticket.
. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$services = @('SPTimerV4', 'SPAdminV4')

# --- objective: timer-running (critical) -------------------------------------
# The service that runs every timer job: alerts, feeds, scheduled anything.
$timerState = Get-OnTrakServiceState -Name 'SPTimerV4'
Add-OnTrakCheck -Objective 'timer-running' -Passed ($timerState -eq 'Running') -Detail ('SPTimerV4 is ' + $timerState)

# --- objective: admin-running ------------------------------------------------
# The service that runs provisioning work — the stuck site collection was this.
$adminState = Get-OnTrakServiceState -Name 'SPAdminV4'
Add-OnTrakCheck -Objective 'admin-running' -Passed ($adminState -eq 'Running') -Detail ('SPAdminV4 is ' + $adminState)

# --- objective: farm-services-automatic --------------------------------------
# The half of the fix that survives a restart.
$notAutomatic = @($services | Where-Object { ('' + (Get-Service -Name $_ -ErrorAction SilentlyContinue).StartType) -ne 'Automatic' })
if ($notAutomatic.Count -eq 0) {
    Add-OnTrakCheck -Objective 'farm-services-automatic' -Passed $true -Detail 'both farm services start automatically'
} else {
    Add-OnTrakCheck -Objective 'farm-services-automatic' -Passed $false -Detail ('not set to automatic: ' + ($notAutomatic -join ', '))
}

Write-OnTrakReport
