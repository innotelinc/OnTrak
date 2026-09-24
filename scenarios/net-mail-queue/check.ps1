# Grading for net-mail-queue: the service is back, mail is genuinely accepted —
# a real SMTP transaction, not a socket — and the fix survives a restart.
. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSExchangeTransport'

# --- objective: transport-running (critical) ---------------------------------
# The service that carries mail. Not IIS, not the mail database: submission and
# delivery both fail while this one is down.
$state = Get-OnTrakServiceState $serviceName
Add-OnTrakCheck -Objective 'transport-running' -Passed ($state -eq 'Running') -Detail ($serviceName + ' is ' + $state)

# --- objective: smtp-accepts-mail (critical) ---------------------------------
# The outcome the senders experience: a complete SMTP conversation the server
# takes responsibility for. A TCP connect to port 25 is *not* this test — the
# ticket passes that before the fix.
$accepted = $false
$smtpDetail = 'the probe did not run'
try {
    $accepted = Test-OnTrakSmtpProbe
    $smtpDetail = ('SMTP transaction to 127.0.0.1:25 (banner, EHLO, MAIL FROM, RCPT TO, DATA) accepted: ' + $accepted)
} catch {
    $smtpDetail = ('the SMTP probe failed: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'smtp-accepts-mail' -Passed $accepted -Detail $smtpDetail

# --- objective: transport-automatic ------------------------------------------
# The state that survives Monday's restart.
$startType = 'Missing'
try { $startType = '' + (Get-Service -Name $serviceName -ErrorAction Stop).StartType } catch { }
Add-OnTrakCheck -Objective 'transport-automatic' -Passed ($startType -eq 'Automatic') -Detail ('startup type is ' + $startType)

Write-OnTrakReport
