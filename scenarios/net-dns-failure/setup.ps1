# Fault: the contractor set a static DNS server that does not exist, so every
# name lookup on the guest times out. Address assignment stays on DHCP, so the
# ticket ("everything resolves fine for my colleagues") stays plausible.
#
# Reversible by: Set-DnsClientServerAddress -InterfaceAlias <name> -ResetServerAddresses
#                (or "Obtain DNS server address automatically" in the GUI)

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$bogusDns = '10.20.0.99'

# The adapter is what the fault is injected into, so its absence is not a scenario
# with a gentler fault -- it is no scenario at all.
Require-OnTrak 'there is an active adapter to break' { [bool](Get-OnTrakPrimaryAdapterName) }
$adapter = Get-OnTrakPrimaryAdapterName

Write-OnTrakStep ("breaking DNS on adapter '" + $adapter + "'")
Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $bogusDns -ErrorAction SilentlyContinue

# A cached negative/SOA entry would hide the fault for a few minutes and make
# the first check inconsistent between students.
try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }

# Make the fault immediately observable in the ticket's own terms.
$probe = Test-OnTrakDnsName -Name 'fileserver.ontrak.lab'
Write-OnTrakStep ("intranet name resolves after fault: " + $probe + " (expected False)")

# Asserted on what the guest now does, not on the call having been made: a fault
# that was written and then lost is indistinguishable from one never injected, and
# the second half is what the student's ticket is actually about.
Require-OnTrak ("the adapter resolves through " + $bogusDns + " instead of the lab resolver") {
    (Get-OnTrakDnsServerAddress -InterfaceAlias $adapter) -contains $bogusDns
}
Require-OnTrak 'the intranet name no longer resolves' {
    -not (Test-OnTrakDnsName -Name 'fileserver.ontrak.lab')
}

Write-OnTrakSetupOk -Note ('dns=' + $bogusDns + ' adapter=' + $adapter)
