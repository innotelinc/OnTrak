# Grading. Accepts any configuration that restores the standard behaviour: DHCP
# is what the estate uses, but a correct static address would also demonstrate
# working connectivity — the objectives below grade the outcome, not the method,
# except for dhcp-enabled, which is the documented site standard.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$adapter = Get-OnTrakPrimaryAdapterName
$dhcpEnabled = Test-OnTrakDhcpEnabled -InterfaceAlias $adapter
$gatewayOk = Test-OnTrakDefaultGatewayReachable
$addresses = @(Get-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress)
$addressText = if ($addresses.Count -gt 0) { $addresses -join ', ' } else { 'none' }
$serviceOk = Test-OnTrakTcpPort -ComputerName 'fileserver.ontrak.lab' -Port 80

# Objective: dhcp-enabled
Add-OnTrakCheck -Objective 'dhcp-enabled' `
    -Passed $dhcpEnabled `
    -Detail ("adapter=" + $adapter + "; DHCP=" + $dhcpEnabled + "; addresses=" + $addressText)

# Objective: gateway-reachable
$gateway = ''
$cfg = Get-NetIPConfiguration -InterfaceAlias $adapter -ErrorAction SilentlyContinue
if ($cfg -and $cfg.IPv4DefaultGateway) { $gateway = $cfg.IPv4DefaultGateway.NextHop }
Add-OnTrakCheck -Objective 'gateway-reachable' `
    -Passed $gatewayOk `
    -Detail ("default gateway=" + $gateway + "; responds=" + $gatewayOk)

# Objective: reach-intranet
Add-OnTrakCheck -Objective 'reach-intranet' `
    -Passed $serviceOk `
    -Detail ("TCP fileserver.ontrak.lab:80 -> " + $serviceOk)

Write-OnTrakReport
