# sql-server.ps1 — SQL Server 2019/2022, installed unattended and then verified.
#
# Layered onto win2019/win2022 by the catalog entries sql-server-2019 and
# sql-server-2022 (catalog/server-products.yaml). The base image is a plain Windows
# Server with the training account on it; this is the product on top.
#
# Four choices worth knowing about when you read the ticket this platform is for:
#
#   * a ConfigurationFile.ini rather than a wall of switches, because that is the
#     supported unattended path and it keeps every decision in one reviewable file;
#   * *virtual* service accounts (NT SERVICE\MSSQLSERVER), which is what Microsoft
#     recommends now and what makes the instance work without a directory to put a
#     service account in;
#   * mixed-mode authentication with an `sa` password from the descriptor, because
#     "the application cannot connect" is where this workload's tickets start;
#   * TCP/IP on plus a firewall rule, since a SQL Server that only answers on shared
#     memory is not something a student can be given a network fault to fix.
#
# It finishes by proving the instance responds on TCP 1433 rather than by trusting
# setup's exit code.
#
# Not run against real media: no SQL Server media ships here and no Windows VM runs in
# this checkout. See docs/roadmap.md for the honest label.

. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin
$config = Get-ProductConfig
if (-not $config.sa_password) {
    Fail 'the descriptor carries no sa_password: the instance would have no SQL login to test with'
}

$media = Get-MediaFolder -Probe 'setup.exe' -Folder $config.media_folder
$setup = Join-Path $media 'setup.exe'
Step ('SQL Server media: ' + $media + ' (version ' + $config.version + ')')

# The training account gets sysadmin as well as the built-in administrators: a scenario
# that hands a student a broken login is no use if they cannot get in to see anything.
$admins = @('BUILTIN\Administrators')
if ($config.user) { $admins += ($env:COMPUTERNAME + '\' + $config.user) }

$ini = Join-Path $env:TEMP 'ontrak-sql-install.ini'
$options = @(
    '[OPTIONS]'
    'ACTION="Install"'
    'QUIET="True"'
    # The license terms and the privacy notice both have to be accepted for a quiet
    # run: Microsoft's parameter table marks each as required whenever /Q or /QS is
    # in play, and the ini is where this build keeps such decisions.
    'IACCEPTSQLSERVERLICENSETERMS="True"'
    'SUPPRESSPRIVACYSTATEMENTNOTICE="True"'
    'FEATURES="SQLEngine,FullText"'
    'INSTANCENAME="MSSQLSERVER"'
    'SQLCOLLATION="SQL_Latin1_General_CP1_CI_AS"'
    'SQLSVCSTARTUPTYPE="Automatic"'
    'AGTSVCSTARTUPTYPE="Manual"'
    'SQLSVCACCOUNT="NT SERVICE\MSSQLSERVER"'
    'AGTSVCACCOUNT="NT SERVICE\SQLSERVERAGENT"'
    'SECURITYMODE="SQL"'
    ('SAPWD="' + $config.sa_password + '"')
    'TCPENABLED="1"'
    'NPENABLED="0"'
    'UPDATEENABLED="False"'
    'ERRORREPORTING="False"'
    ('SQLSYSADMINACCOUNTS="' + ($admins -join '" "') + '"')
)
Set-Content -Path $ini -Value $options -Encoding ASCII
Step ('wrote ' + $ini)

# The instance's registration key, read by the install and the verification alike.
$instances = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'

# Guarded and resumed like the domain products' expensive steps, because SQL setup
# owns a restart of its own and its exit code 3010 carries both of Microsoft's
# documented meanings: "the install finished, restart to complete it", and "a restart
# is pending, so I will not install anything". Which one it was is told by the
# registry: an instance that got registered means the first, so the done-mark goes
# down and the reboot happens before verification; no instance means the second, and
# nothing is marked done, so the next pass runs setup again on the restarted machine.
# A re-run against an installed instance is a failure ("already installed"), which is
# what the done-mark makes impossible.
if (-not (Test-StepDone 'sql-installed')) {
    $code = Invoke-InstallStep -FilePath $setup -What 'SQL Server setup' -Arguments @(
        ('/ConfigurationFile=' + $ini),
        '/IACCEPTSQLSERVERLICENSETERMS',
        '/QUIET'
    )
    if ($code -eq 3010 -and -not (Test-Path $instances)) {
        Request-Reboot 'SQL Server setup will not install while a restart is pending, and asks for one first'
    }
    Set-StepDone 'sql-installed'
    if ($code -eq 3010) {
        Request-Reboot 'SQL Server setup is complete and says the machine must restart before anything is verified'
    }
}

# -- verification --------------------------------------------------------------
# Three independent readings, because setup can report success for an instance that
# is installed and not usable: the service, the registered instance, and the socket.
$service = Get-Service -Name MSSQLSERVER -ErrorAction SilentlyContinue
if (-not $service) {
    Fail 'setup reported success and there is no MSSQLSERVER service, so there is no instance'
}
if ($service.Status -ne 'Running') {
    Step 'the instance is installed and not running; starting it'
    Start-Service -Name MSSQLSERVER
}
if ((Get-Service -Name MSSQLSERVER).Status -ne 'Running') {
    Fail 'the instance exists and will not start — its log is the next thing to read'
}

if (-not (Test-Path $instances)) {
    Fail 'no instance registry key: the install did not get as far as registering one'
}
Step 'the instance is registered in the registry'

New-NetFirewallRule -DisplayName 'OnTrak SQL Server (TCP 1433)' -Direction Inbound `
    -Protocol TCP -LocalPort 1433 -Action Allow -ErrorAction SilentlyContinue | Out-Null

$listening = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', 1433)
    } catch {
        Start-Sleep -Seconds 2
    }
    if ($client.Connected) {
        $listening = $true
        $client.Close()
        break
    }
    $client.Close()
}
if (-not $listening) {
    Fail 'the instance is running and never accepted a connection on TCP 1433'
}
Step 'the instance answered a real TCP connection on 1433'

Write-Output $productOkMarker
Write-Output ('sql-server ' + $config.version + ' installed and listening on 1433')
