# Fault: the contractor set a static DNS server that does not exist, so every
# name lookup on the guest times out. Address assignment stays on DHCP, so the
# ticket ("everything resolves fine for my colleagues") stays plausible.
#
# Reversible by: Set-DnsClientServerAddress -InterfaceAlias <name> -ResetServerAddresses
#                (or "Obtain DNS server address automatically" in the GUI)

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$bogusDns = '10.20.0.99'
$adapter = Get-OnTrakPrimaryAdapterName

if (-not $adapter) {
    Write-OnTrakStep 'no active adapter found; cannot inject DNS fault'
} else {
    Write-OnTrakStep ("breaking DNS on adapter '" + $adapter + "'")
    Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $bogusDns -ErrorAction SilentlyContinue

    # A cached negative/SOA entry would hide the fault for a few minutes and make
    # the first check inconsistent between students.
    try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }

    # Make the fault immediately observable in the ticket's own terms.
    $probe = Test-OnTrakDnsName -Name 'fileserver.ontrak.lab'
    Write-OnTrakStep ("intranet name resolves after fault: " + $probe + " (expected False)")
}

Write-OnTrakSetupOk -Note ('dns=' + $bogusDns + ' adapter=' + $adapter)
