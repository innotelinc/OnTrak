# net-mail-queue — the transport service knocked out behind a healthy port.
#
# The trap is the difference between a listener and a service: Exchange's SMTP
# frontend keeps answering TCP 25 with a banner even when the transport service
# behind it is dead, so "port 25 is open" — the fact the service desk already
# checked — proves nothing about mail. Meanwhile nothing can be submitted
# (messages sit in the Outbox) and nothing can be delivered (external senders
# are refused).
#
# The story: a weekend "hardening" script left the Microsoft Exchange Transport
# service stopped and disabled. Fixing the ticket means the service is running,
# mail is genuinely accepted end to end, and the service starts on its own again.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSExchangeTransport'

# ------------------------------------------------------------- the fault ----
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
Write-OnTrakStep ('the weekend hardening script left ' + $serviceName + ' stopped and disabled')

# ---------------------------------------------------------- assertions ------
Require-OnTrak 'the transport service is stopped and disabled' {
    (Get-OnTrakServiceState $serviceName) -ne 'Running'
}
Require-OnTrak 'the fault is observable: the server no longer takes mail' {
    -not (Test-OnTrakSmtpProbe)
}

Write-OnTrakSetupOk -Note 'transport service disabled and stopped behind a port 25 that still answers'
