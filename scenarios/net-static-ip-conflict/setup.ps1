# Fault: the adapter is manually addressed (DHCP off) with a default gateway that
# does not exist. The machine keeps the address it already had, so on-link traffic
# — including a remote session — is unaffected, while every off-subnet destination
# times out. A machine with no route out still reports itself as "connected", which
# is the whole reason this deserves a ticket.
#
# Reversible by: Set-NetIPInterface -Dhcp Enabled; ipconfig /renew
#                (or "Obtain an IP address automatically" in the GUI)
#
# The fault is injected *in-band*, and the address is deliberately left alone. An
# earlier version replaced the adapter's address with a different fixed one: that
# ended the very WinRM session injecting it, and it left Incus still reporting the
# DHCP lease the guest had taken away, so the build asked the old address forever
# and could never read the confirmation the script had written. Keeping the address
# is what lets one script inject the fault, verify it, and confirm it.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$badGateway = '10.20.0.254'
$dns = '10.20.0.1'

# The adapter is what the fault is injected into, so its absence is not a scenario
# with a gentler fault -- it is no scenario at all.
Require-OnTrak 'there is an active adapter to re-address' { [bool](Get-OnTrakPrimaryAdapterName) }
$adapter = Get-OnTrakPrimaryAdapterName

# The address the machine is already reachable on. "Hardcoded settings" is the
# story, and what a contractor hardcodes is the address they found: the fault is
# that the settings are manual and the gateway is wrong, not that the address
# moved.
$current = @(Get-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -ne 'WellKnown' })
Require-OnTrak 'the adapter holds an address to hardcode' { $current.Count -gt 0 }
$staticIp = $current[0].IPAddress
$staticPrefix = $current[0].PrefixLength

Write-OnTrakStep ("hardcoding '" + $adapter + "' at " + $staticIp + " gw " + $badGateway)

# DHCP off is what turns a leased address into "hardcoded settings". Windows keeps
# the address it is already using, so nothing on-link notices — and if this build of
# Windows did drop it instead, the address is put straight back below, because the
# transport this script is verified over runs on that address.
Set-NetIPInterface -InterfaceAlias $adapter -AddressFamily IPv4 -Dhcp Disabled -ErrorAction SilentlyContinue
$stillAddressed = @(Get-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $staticIp })
if ($stillAddressed.Count -eq 0) {
    New-NetIPAddress -InterfaceAlias $adapter -IPAddress $staticIp -PrefixLength $staticPrefix `
        -ErrorAction SilentlyContinue | Out-Null
}

# The default route is where "the network is unreachable" actually lives. Removing
# it and pointing it at a host that is not there is the fault; the on-link subnet
# route stays, which is why the machine still answers a remote session.
Get-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
New-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' `
    -NextHop $badGateway -ErrorAction SilentlyContinue | Out-Null
Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $dns -ErrorAction SilentlyContinue
try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }

# The address is asserted first, and it is not decoration: the build confirms this
# fault over the network at exactly this address, so a fault that took the address
# away would leave a machine with the right symptom and no way to prove it.
Require-OnTrak 'the machine still holds the address a session can reach it on' {
    @(Get-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -eq $staticIp }).Count -gt 0
}

# Then assert on what the fault *does*, never on the cmdlets that produced it: an
# image that was already static, or one whose route table already had no default,
# still ends up with a working fault.
Require-OnTrak 'the adapter no longer takes its address from DHCP' {
    -not (Test-OnTrakDhcpEnabled -InterfaceAlias $adapter)
}
Require-OnTrak 'the default gateway is the non-existent 10.20.0.254' {
    @(Get-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -eq $badGateway }).Count -gt 0
}
Require-OnTrak 'off-subnet destinations are unreachable' { -not (Test-OnTrakDefaultGatewayReachable) }

Write-OnTrakSetupOk -Note ('manual=' + $staticIp + ' gw=' + $badGateway)
