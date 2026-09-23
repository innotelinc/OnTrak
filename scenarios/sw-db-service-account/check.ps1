# Grading for sw-db-service-account: the service up, the connection working, and
# the logon left on the estate standard. The middle one is the application's own
# shape of proof — a query over a connection — because a running service that
# nothing can reach is still this ticket, open.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSSQLSERVER'
$standardAccount = 'NT SERVICE\MSSQLSERVER'

# --- objective: service-running -----------------------------------------------
$state = Get-OnTrakServiceState $serviceName
Add-OnTrakCheck -Objective 'service-running' -Passed ($state -eq 'Running') `
    -Detail ('MSSQLSERVER service state: ' + $state)

# --- objective: app-can-connect -----------------------------------------------
$appOk = $false
$appDetail = 'not tried'
try {
    $rows = Invoke-OnTrakSql -Query 'SELECT @@VERSION AS version'
    $appOk = $true
    $appDetail = 'connected and ran a query: ' + (([string] $rows[0].version) -replace '\s+', ' ').Substring(0, 40)
} catch {
    $appDetail = 'the query failed: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'app-can-connect' -Passed $appOk -Detail $appDetail

# --- objective: logon-standard ------------------------------------------------
# Read of the service's configuration, not of who is running: a service that
# started once under a lucky setting still owes the estate its standard.
$startName = ''
try {
    $startName = [string] (Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $serviceName + "'")).StartName
} catch { }
Add-OnTrakCheck -Objective 'logon-standard' -Passed ($startName -ieq $standardAccount) `
    -Detail ('service logon: ' + $startName + ' (standard: ' + $standardAccount + ')')

Write-OnTrakReport
