# Grading. Reads the live configuration rather than a recorded answer, so any
# correct fix passes (DHCP, statically pointing at the working resolver, or
# restoring a golden image settings baseline).

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$bogusDns = '10.20.0.99'
$adapter = Get-OnTrakPrimaryAdapterName
$servers = @(Get-OnTrakDnsServerAddress -InterfaceAlias $adapter)
$serversText = if ($servers.Count -gt 0) { $servers -join ', ' } else { 'none configured' }
$usesBogus = $servers -contains $bogusDns

$resolvesIntranet = Test-OnTrakDnsName -Name 'fileserver.ontrak.lab'
$reachable = Test-OnTrakTcpPort -ComputerName 'fileserver.ontrak.lab' -Port 80

# Objective: restore-resolver
# The adapter must be back on a working resolver. Empty server list is fine (that
# means DHCP is supplying them), as long as the lookup below actually works.
Add-OnTrakCheck -Objective 'restore-resolver' `
    -Passed ((-not $usesBogus) -and $resolvesIntranet) `
    -Detail ("adapter=" + $adapter + "; dns servers=" + $serversText + "; lookup works=" + $resolvesIntranet)

# Objective: resolve-intranet
Add-OnTrakCheck -Objective 'resolve-intranet' `
    -Passed $resolvesIntranet `
    -Detail ("Resolve-DnsName fileserver.ontrak.lab -DnsOnly -> " + $resolvesIntranet)

# Objective: reach-service
Add-OnTrakCheck -Objective 'reach-service' `
    -Passed $reachable `
    -Detail ("TCP fileserver.ontrak.lab:80 -> " + $reachable)

Write-OnTrakReport
