# net-db-firewall — "the firewall rule somebody added".
#
# The change window's temporary lockdown, rolled back everywhere except here:
# the estate's allow rule for the database port is disabled and a block rule
# takes its place. The database is untouched and healthy, which is the point —
# the fault is entirely in the firewall, and the evidence is the rules.
#
# Grading keys on the rules rather than on a probe, and that is deliberate:
# loopback traffic does not cross Windows Firewall rules, so no test from this
# machine can see the block at all. Only the rule list is honest evidence here.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$allowRule = 'OnTrak SQL Server (TCP 1433)'
$blockRule = 'Temporary lockdown (change window)'

# The estate rule the product build leaves behind: recreated if a previous
# attempt deleted it, then disabled exactly as the lockdown left it.
if (-not (Get-NetFirewallRule -DisplayName $allowRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $allowRule -Direction Inbound -Protocol TCP `
        -LocalPort 1433 -Action Allow | Out-Null
}
Disable-NetFirewallRule -DisplayName $allowRule -ErrorAction SilentlyContinue

# The rule somebody added and nobody removed. One of them, whatever a re-run
# left behind earlier.
Get-NetFirewallRule -DisplayName $blockRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $blockRule -Direction Inbound -Protocol TCP `
    -LocalPort 1433 -Action Block -Profile Any | Out-Null

Write-OnTrakStep ('inbound TCP 1433 now hits the block rule ' + $blockRule)

Require-OnTrak 'the lockdown block rule is in place and enabled' {
    $rule = Get-NetFirewallRule -DisplayName $blockRule -ErrorAction SilentlyContinue
    ($null -ne $rule) -and ($rule.Enabled -eq 'True') -and ($rule.Action -eq 'Block')
}
Require-OnTrak 'the estate allow rule is disabled, as the lockdown left it' {
    $rule = Get-NetFirewallRule -DisplayName $allowRule -ErrorAction SilentlyContinue
    ($null -ne $rule) -and ($rule.Enabled -eq 'False')
}

Write-OnTrakSetupOk -Note ('blocked inbound TCP 1433 with ' + $blockRule)
