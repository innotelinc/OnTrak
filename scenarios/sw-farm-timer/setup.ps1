# sw-farm-timer — the farm services behind the intranet, stopped and disabled.
#
# The trap: SharePoint's sites are the web server's and keep serving pages while
# the farm itself does nothing. The timer service (SPTimerV4) runs every
# scheduled job — alerts, the dashboard's feeds, timer job history — and the
# administration service (SPAdminV4) runs provisioning work such as creating
# site collections. A "performance tuning" script on Friday left both stopped
# and disabled.
#
# Fixing the ticket means both services running, both starting automatically,
# and — since the sites never stopped — no "fix" aimed at the web server.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$services = @('SPTimerV4', 'SPAdminV4')

# ------------------------------------------------------------- the fault ----
foreach ($serviceName in $services) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
    Write-OnTrakStep ($serviceName + ' is stopped and disabled')
}

# ---------------------------------------------------------- assertions ------
Require-OnTrak 'both farm services are down' {
    (@($services | Where-Object { (Get-OnTrakServiceState $_) -eq 'Running' }).Count -eq 0)
}
Require-OnTrak 'both farm services are disabled' {
    (@($services | Where-Object { ('' + (Get-Service -Name $_ -ErrorAction SilentlyContinue).StartType) -eq 'Disabled' }).Count -eq 2)
}
Require-OnTrak 'the trap is in place: the farm still answers web requests' {
    # Central Administration on its install-time port (8080 unless the product
    # descriptor said otherwise): the sites never stop serving, which is why
    # "the intranet is up" is the ticket's red herring.
    Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 8080
}

Write-OnTrakSetupOk -Note 'timer and administration services disabled and stopped behind healthy sites'
