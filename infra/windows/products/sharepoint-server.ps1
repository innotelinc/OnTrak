# sharepoint-server.ps1 — SharePoint Server Subscription Edition, on its own forest.
#
# Layered onto the sql-server-2022 entry (catalog/server-products.yaml), which is
# itself layered onto win2022: a farm without its database server is not a farm, so the
# base image already has SQL Server running locally and this installs on top of it.
#
# The sequence is Microsoft's documented unattended one, with the two prerequisites a
# single-machine farm needs written out rather than assumed:
#
#   1. a forest, because SharePoint is a directory product too — the same promotion the
#      Exchange script does, for the same reason (see that file's header);
#   2. the farm account, plus the SQL login and the roles the configuration database
#      needs before the farm can be created;
#   3. `PrerequisiteInstaller.exe /unattended`, which installs the server roles and
#      features SharePoint wants, and needs either internet access or an offline
#      prerequisite folder named in the descriptor;
#   4. `setup.exe /config` for the binaries, then `psconfig.exe` to create the
#      configuration database, provision Central Administration, install the help
#      collections, secure the resources and start the services.
#
# Verification is the timer service and Central Administration answering on its port,
# which is what a support desk means by "the farm is up".
#
# Not run against real media: no SharePoint media ships here, the prerequisite
# installer downloads from Microsoft, and no Windows VM runs in this checkout. See
# docs/roadmap.md for the honest label.

. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin
$config = Get-ProductConfig
if (-not $config.domain) { Fail 'the descriptor names no domain, and SharePoint is a directory product' }
if (-not $config.farm_account -or -not $config.farm_password) {
    Fail 'the descriptor carries no farm account: the configuration database is created by one'
}

if (-not (Test-StepDone 'forest-promoted')) {
    Ensure-AdministratorPassword -Password $config.admin_password
}
Assert-Forest -Domain $config.domain -SafeModePassword $config.safe_mode_password
Wait-ForDirectory

$adminAccount = $config.domain + '\Administrator'
$media = Get-MediaFolder -Probe 'setup.exe' -Folder $config.media_folder
Step ('SharePoint media: ' + $media + ' (version ' + $config.version + ')')

# -- the farm account and its database rights ----------------------------------
# The configuration wizard would ask for these interactively; unattended, they have to
# exist first: a local (now domain) account, and a SQL login holding the two roles the
# configuration database needs.
# After the promotion the account is a domain account, so the login is named for the
# domain (the machine's NetBIOS name is the forest's on a first DC, but saying so is
# clearer than relying on it).
$netbios = ($config.domain -split '\.')[0].ToUpper()
$farmLogin = $netbios + '\' + $config.farm_account
New-LocalAccount -Account $config.farm_account -Password $config.farm_password
New-SqlLogin -Instance $config.sql_instance -Account $farmLogin -Password $config.farm_password
Set-StepDone 'farm-account'

# -- prerequisites -------------------------------------------------------------
if (-not (Test-StepDone 'prerequisites-installed')) {
    $prereq = Join-Path $media 'PrerequisiteInstaller.exe'
    if (-not (Test-Path $prereq)) {
        Fail ('no PrerequisiteInstaller.exe on the media at ' + $media)
    }
    $arguments = @('/unattended')
    if ($config.prereq_folder) {
        # An offline prerequisite folder: the same switches the wizard builds when it is
        # told to use local files, which is what a range without internet needs.
        $arguments += @(
            '/SQLNCli:' + (Join-Path $config.prereq_folder 'SQLNCli.msi'),
            '/Sync:' + (Join-Path $config.prereq_folder 'Synchronization.msi'),
            '/AppFabric:' + (Join-Path $config.prereq_folder 'AppFabric.msi')
        )
    }
    Invoke-InstallStep -FilePath $prereq -What 'SharePoint prerequisite installer' `
        -Arguments $arguments -TimeoutSeconds 3600 | Out-Null
    Set-StepDone 'prerequisites-installed'
}

# -- binaries ------------------------------------------------------------------
if (-not (Test-StepDone 'binaries-installed')) {
    $silentXml = Join-Path $env:TEMP 'ontrak-sharepoint-setup.xml'
    @'
<Configuration>
  <Logging Type="verbose" Path="C:\ProgramData\OnTrak\logs" />
  <Setting Id="SETUP_REBOOT" Value="Never" />
</Configuration>
'@ | Set-Content -Path $silentXml -Encoding ASCII
    Invoke-InstallStep -FilePath (Join-Path $media 'setup.exe') -What 'SharePoint setup' `
        -Arguments @('/config', $silentXml) -TimeoutSeconds 5400 | Out-Null
    Set-StepDone 'binaries-installed'
}

# -- the farm ------------------------------------------------------------------
# `psconfig.exe` is the unattended half of the configuration wizard, and the order
# below is the wizard's own: the configuration database, then Central Administration,
# then the rest of what a usable farm needs. Run as the domain Administrator, because
# creating a farm writes to the configuration database and to the local server.
if (-not (Test-StepDone 'farm-created')) {
    $psconfig = Join-Path $env:ProgramFiles 'Common Files\Microsoft Shared\Web Server Extensions\16\BIN\psconfig.exe'
    if (-not (Test-Path $psconfig)) {
        Fail ('SharePoint setup reported success and ' + $psconfig + ' is not there')
    }
    $port = if ($config.port) { [int] $config.port } else { 8080 }
    $configDb = 'SharePoint_Config'
    $commands = @(
        @('-cmd', 'configdb', '-create', '-server', $config.sql_instance, '-database', $configDb,
            '-user', $farmLogin, '-password', $config.farm_password,
            '-passphrase', $config.farm_passphrase, '-admincontentdatabase', 'SharePoint_AdminContent'),
        @('-cmd', 'adminvs', '-provision', '-port', "$port", '-windowsauthprovider', 'onlyusewindowsauth'),
        @('-cmd', 'helpcollections', '-installall'),
        @('-cmd', 'secureresources'),
        @('-cmd', 'services', '-install'),
        @('-cmd', 'security', '-installservices')
    )
    foreach ($command in $commands) {
        $code = Invoke-InstallStep -FilePath $psconfig -What ('psconfig ' + ($command -join ' ')) `
            -Arguments $command -Account $adminAccount -Password $config.admin_password `
            -TimeoutSeconds 3600 -AllowFailure
        if ($code -ne 0 -and $code -ne 3010) {
            Fail ('psconfig ' + ($command -join ' ') + ' failed (exit ' + $code + '): its output is in ' +
                'C:\ProgramData\OnTrak\logs')
        }
    }
    Set-StepDone 'farm-created'
}

# -- verification --------------------------------------------------------------
$timer = Get-Service -Name SPTimerV4 -ErrorAction SilentlyContinue
if (-not $timer) { Fail 'the farm was created and there is no SPTimerV4 service' }
if ($timer.Status -ne 'Running') { Fail 'SPTimerV4 is installed and not running' }
Step 'the SharePoint timer service is running'

$port = if ($config.port) { [int] $config.port } else { 8080 }
$status = 0
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $status = Get-WebResponseStatus -Url ('http://localhost:' + $port + '/')
    if ($status -gt 0) { break }
    Start-Sleep -Seconds 10
}
if ($status -eq 0) {
    Fail ('Central Administration never answered on port ' + $port +
        ': the farm exists and the web application is not serving')
}
Step ('Central Administration answered ' + $status + ' on port ' + $port)

Write-Output $productOkMarker
Write-Output ('sharepoint ' + $config.version + ' farm created on ' + $config.domain)
