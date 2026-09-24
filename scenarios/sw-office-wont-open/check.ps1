# Grading for sw-office-wont-open: the service is back, the fix survives a
# restart, and an app genuinely launches — by the only proof that cannot be
# faked by an error dialog, Office's own automation object.
. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'ClickToRunSvc'

# --- objective: office-service-running (critical) ----------------------------
# What every app in the suite starts through. Reinstalling Office restores it
# too — any correct fix passes; the write-up prices which fix was rational.
$state = Get-OnTrakServiceState $serviceName
Add-OnTrakCheck -Objective 'office-service-running' -Passed ($state -eq 'Running') -Detail ($serviceName + ' is ' + $state)

# --- objective: office-service-automatic -------------------------------------
# The half that survives Monday's restart.
$startType = 'Missing'
try { $startType = '' + (Get-Service -Name $serviceName -ErrorAction Stop).StartType } catch { }
Add-OnTrakCheck -Objective 'office-service-automatic' -Passed ($startType -eq 'Automatic') -Detail ('startup type is ' + $startType)

# --- objective: office-apps-launch (critical) --------------------------------
$launchOk = Test-OnTrakComLaunch -ProgId 'Word.Application'
Add-OnTrakCheck -Objective 'office-apps-launch' -Passed $launchOk -Detail ('Word started and quit through its automation object: ' + $launchOk)

Write-OnTrakReport
