# Grading for net-db-protocols: the protocols the estate standard keeps on, and
# proof over TCP rather than over the shared-memory shortcut a local tool takes.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSSQLSERVER'
$instanceMap = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
$instanceId = [string] (Get-ItemProperty -Path $instanceMap -Name $serviceName -ErrorAction Stop).$serviceName
$protocols = Join-Path ('HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\' + $instanceId) 'MSSQLServer\SuperSocketNetLib'

# --- objective: tcp-enabled ----------------------------------------------------
$tcpValue = 0
try {
    $tcpValue = [int] (Get-ItemProperty -Path (Join-Path $protocols 'Tcp') -Name 'Enabled' -ErrorAction Stop).Enabled
} catch { }
Add-OnTrakCheck -Objective 'tcp-enabled' -Passed ($tcpValue -eq 1) `
    -Detail ('TCP/IP Enabled value: ' + $tcpValue)

# --- objective: named-pipes-enabled -------------------------------------------
$npValue = 0
try {
    $npValue = [int] (Get-ItemProperty -Path (Join-Path $protocols 'Np') -Name 'Enabled' -ErrorAction Stop).Enabled
} catch { }
Add-OnTrakCheck -Objective 'named-pipes-enabled' -Passed ($npValue -eq 1) `
    -Detail ('Named Pipes Enabled value: ' + $npValue)

# --- objective: listener-answers ----------------------------------------------
# Socket level: is anything listening on the SQL port at all.
$listening = Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 1433
Add-OnTrakCheck -Objective 'listener-answers' -Passed $listening `
    -Detail ('TCP connect to 127.0.0.1:1433: ' + $listening)

# --- objective: app-can-connect ------------------------------------------------
# TDS level, and forced onto TCP: a default local connection would ride shared
# memory and pass with every protocol off, which is the trap of this ticket.
$appOk = $false
$appDetail = 'not tried'
try {
    Invoke-OnTrakSql -Server 'tcp:127.0.0.1,1433' -Query 'SELECT @@VERSION AS version' | Out-Null
    $appOk = $true
    $appDetail = 'a forced TCP connection ran a query'
} catch {
    $appDetail = 'the TCP connection failed: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'app-can-connect' -Passed $appOk -Detail $appDetail

Write-OnTrakReport
