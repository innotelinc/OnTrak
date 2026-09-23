# net-db-protocols — TCP/IP and Named Pipes switched off, shared memory left on.
#
# The trap that makes this a networking ticket and not a database one: SQL
# Server's shared-memory "protocol" is always on for local connections, so every
# tool on the box keeps working while the instance answers no network connection
# at all. The application dials TCP from another machine and sees "connection
# refused"; the technician who checks on the server sees a healthy instance.
#
# The protocols load with the service, so the fault only lands after a restart.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSSQLSERVER'

# The instance's registry root, resolved from the instance map rather than
# hard-coded: MSSQL15.MSSQLSERVER on 2019, MSSQL16.MSSQLSERVER on 2022.
$instanceMap = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
$instanceId = [string] (Get-ItemProperty -Path $instanceMap -Name $serviceName -ErrorAction Stop).$serviceName
$protocols = Join-Path ('HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\' + $instanceId) 'MSSQLServer\SuperSocketNetLib'

foreach ($protocol in @('Tcp', 'Np')) {
    $key = Join-Path $protocols $protocol
    Set-ItemProperty -Path $key -Name 'Enabled' -Value 0 -Type DWord
}
Write-OnTrakStep ('TCP/IP and Named Pipes are off on ' + $instanceId + '; only shared memory remains')

Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Start-Service -Name $serviceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Require-OnTrak 'the instance loads with its network protocols disabled' {
    $tcpOff = (Get-ItemProperty -Path (Join-Path $protocols 'Tcp') -Name 'Enabled').Enabled -eq 0
    $npOff = (Get-ItemProperty -Path (Join-Path $protocols 'Np') -Name 'Enabled').Enabled -eq 0
    $tcpOff -and $npOff
}
Require-OnTrak 'the network fault is observable: nothing answers on the SQL port' {
    (Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 1433) -eq $false
}

Write-OnTrakSetupOk -Note ('instance ' + $instanceId + ' answers on shared memory only')
