# Grading for net-db-firewall. The objectives read the firewall's rule list on
# purpose: loopback traffic does not cross Windows Firewall rules, so a socket
# test from this machine would pass before the fix and grade the fault as
# healthy. The rules are the evidence, and the instance check is a guard against
# "fixing" a firewall ticket by reconfiguring the database.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

# Enabled inbound rules acting on TCP 1433, by action. Port filters live on the
# rule, which is why the two cmdlets are joined rather than guessed at.
function Get-Port1433Rules {
    param([string] $Action)
    $found = @()
    foreach ($rule in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action $Action -ErrorAction SilentlyContinue)) {
        $ports = @(($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort)
        if ($ports -contains '1433') { $found += $rule.DisplayName }
    }
    return $found
}

# --- objective: block-rule-gone ------------------------------------------------
$blockers = @(Get-Port1433Rules -Action 'Block')
$blockerText = 'none'
if ($blockers.Count -gt 0) { $blockerText = $blockers -join ', ' }
Add-OnTrakCheck -Objective 'block-rule-gone' -Passed ($blockers.Count -eq 0) `
    -Detail ('enabled block rules on TCP 1433: ' + $blockerText)

# --- objective: allow-rule-enabled --------------------------------------------
# Outcome-shaped on purpose: the estate rule re-enabled, or a replacement allow
# rule the student left behind, both leave the port open and both pass.
$allowing = @(Get-Port1433Rules -Action 'Allow')
$allowText = 'none'
if ($allowing.Count -gt 0) { $allowText = $allowing -join ', ' }
Add-OnTrakCheck -Objective 'allow-rule-enabled' -Passed ($allowing.Count -gt 0) `
    -Detail ('enabled allow rules on TCP 1433: ' + $allowText)

# --- objective: instance-still-answers -----------------------------------------
$state = Get-OnTrakServiceState 'MSSQLSERVER'
$listening = Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 1433
Add-OnTrakCheck -Objective 'instance-still-answers' -Passed ($state -eq 'Running' -and $listening) `
    -Detail ('service: ' + $state + '; local TCP connect on 1433: ' + $listening)

Write-OnTrakReport
