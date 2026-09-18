# Fault: the adapter is static on a plausible address, but with a gateway that
# does not exist. The guest stays reachable on-link (which is why remote support
# still works) while every off-subnet destination times out.
#
# Reversible by: Set-NetIPInterface -Dhcp Enabled; ipconfig /renew
#                (or "Obtain an IP address automatically" in the GUI)

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$staticIp = '10.20.0.5'
$staticPrefix = 24
$badGateway = '10.20.0.254'
$dns = '10.20.0.1'
$adapter = Get-OnTrakPrimaryAdapterName

if (-not $adapter) {
    Write-OnTrakStep 'no active adapter found; cannot inject addressing fault'
} else {
    Write-OnTrakStep ("setting '" + $adapter + "' to static " + $staticIp + "/" + $staticPrefix + " gw " + $badGateway)

    $existing = @(Get-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.PrefixOrigin -ne 'WellKnown' })
    foreach ($address in $existing) {
        Remove-NetIPAddress -IPAddress $address.IPAddress -InterfaceIndex $address.InterfaceIndex -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue

    New-NetIPAddress -InterfaceAlias $adapter -IPAddress $staticIp -PrefixLength $staticPrefix `
        -DefaultGateway $badGateway -ErrorAction SilentlyContinue | Out-Null
    Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $dns -ErrorAction SilentlyContinue
    try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }

    $gatewayOk = Test-OnTrakDefaultGatewayReachable
    Write-OnTrakStep ("gateway reachable after fault: " + $gatewayOk + " (expected False)")
}

Write-OnTrakSetupOk -Note ('static=' + $staticIp + ' gw=' + $badGateway)
