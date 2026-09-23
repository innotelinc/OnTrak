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
#      prerequisite folder named in the descriptor — restarting the guest and
#      re-running it with `/continue` whenever the tool says a restart is needed,
#      which is the contract Microsoft documents for it;
#   4. `setup.exe /config` for the binaries, the restart Microsoft asks for once
#      setup completes, then `psconfig.exe` in the configuration wizard's own step
#      order: the configuration database, the help collections, secured resources,
#      the services and features, Central Administration, the application content.
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
# Microsoft's tool, and Microsoft's restart contract: the prerequisite installer
# exits 3010 ("a restart is needed") or 1001 ("a pending restart blocks
# installation") and *skips what remains* until the server is restarted and the tool
# is run again with `/continue`. Neither code is a finished step, so neither marks
# this one done: the builder restarts the guest and this block picks up where the
# tool stopped.
if (-not (Test-StepDone 'prerequisites-installed')) {
    $prereq = Join-Path $media 'PrerequisiteInstaller.exe'
    if (-not (Test-Path $prereq)) {
        Fail ('no PrerequisiteInstaller.exe on the media at ' + $media)
    }
    # Before a restart the tool drops a startup task so it re-runs itself at logon.
    # Nobody logs on to a guest the agent drives — and in the published image that
    # task would fire at a student's first logon instead. Deleting it is Microsoft's
    # own documented workaround, and `/continue` below is the documented way to
    # resume.
    Remove-Item `
        -Path (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup\SharePointServerPreparationToolStartup_*.cmd') `
        -Force -ErrorAction SilentlyContinue

    $arguments = @()
    if (Test-StepDone 'prerequisites-restarted') {
        # "After restarting, you should continue the prerequisite installation by
        # running prerequisiteinstaller.exe with the /continue option."
        $arguments += @('/continue', '/unattended')
    } else {
        $arguments += '/unattended'
    }
    if ($config.prereq_folder) {
        # An offline prerequisite folder: the switch-and-path pairs for each
        # prerequisite the tool installs (`PrerequisiteInstaller.exe /?` is the
        # authority for the media in hand). A pair is passed only when the file is
        # there, and what is absent is named rather than silently skipped.
        $offline = @(
            @('/SQLNCli:', 'sqlncli.msi'),
            @('/Sync:', 'Synchronization.msi'),
            @('/AppFabric:', 'WindowsServerAppFabricSetup_x64.exe'),
            @('/IDFX11:', 'MicrosoftIdentityExtensions-64.msi'),
            @('/MSIPCClient:', 'setup_msipc_x64.msi'),
            @('/WCFDataServices56:', 'WcfDataServices.exe'),
            @('/KB3092423:', 'AppFabric-KB3092423-x64-ENU.exe'),
            @('/MSVCRT11:', 'vcredist_x64.exe'),
            @('/MSVCRT14:', 'vc_redist.x64.exe'),
            @('/DotNetFx:', 'ndp48-x86-x64-allos-enu.exe')
        )
        $absent = @()
        foreach ($pair in $offline) {
            $file = Join-Path $config.prereq_folder $pair[1]
            if (Test-Path $file) {
                $arguments += ($pair[0] + '"' + $file + '"')
            } else {
                $absent += $pair[1]
            }
        }
        if ($absent.Count -gt 0) {
            Step ('not in the offline folder (the tool will try to download them): ' + ($absent -join ', '))
        }
    }
    $code = Invoke-InstallStep -FilePath $prereq -What 'SharePoint prerequisite installer' `
        -Arguments $arguments -TimeoutSeconds 3600 -AllowFailure
    if ($code -eq 3010 -or $code -eq 1001) {
        Set-StepDone 'prerequisites-restarted'
        Request-Reboot ('the prerequisite installer asks for a restart (exit ' + $code + ') and resumes with /continue')
    }
    if ($code -ne 0) {
        Fail ('the SharePoint prerequisite installer failed (exit ' + $code + ')')
    }
    Set-StepDone 'prerequisites-installed'
}

# -- binaries ------------------------------------------------------------------
if (-not (Test-StepDone 'binaries-installed')) {
    # The shape of the file the media itself ships (Files\SetupSilent\config.xml),
    # which is the documented starting point for keyed media: copy that one and put
    # your product key in it instead of writing this. SETUP_REBOOT=Never is
    # deliberate — the restart below is the documented one, and the reboot is the
    # builder's to do.
    $silentXml = Join-Path $env:TEMP 'ontrak-sharepoint-setup.xml'
    @'
<Configuration>
  <Logging Type="verbose" Path="C:\ProgramData\OnTrak\logs" />
  <Setting Id="SETUP_REBOOT" Value="Never" />
</Configuration>
'@ | Set-Content -Path $silentXml -Encoding ASCII
    # /IAcceptTheLicenseTerms is the documented companion of /config; command-line
    # setup does not run without it.
    $code = Invoke-InstallStep -FilePath (Join-Path $media 'setup.exe') -What 'SharePoint setup' `
        -Arguments @('/config', $silentXml, '/IAcceptTheLicenseTerms') -TimeoutSeconds 5400 -AllowFailure
    if ($code -ne 0 -and $code -ne 3010) {
        Fail ('SharePoint setup failed (exit ' + $code + ')')
    }
    Set-StepDone 'binaries-installed'
}

# "Once SharePoint setup has completed, reboot your server." Microsoft's own step
# between the binaries and the farm, so the farm is created on the machine the
# students get and not on the one setup left half-settled.
if (-not (Test-StepDone 'binaries-restarted')) {
    Set-StepDone 'binaries-restarted'
    Request-Reboot 'SharePoint setup is complete and Microsoft asks for a reboot before the farm is created'
}

# -- the farm ------------------------------------------------------------------
# `psconfig.exe` is the unattended half of the configuration wizard — Microsoft
# names it as the alternative to the documented PowerShell sequence — and the verbs
# below are that sequence, one per documented cmdlet, in the documented order:
# configdb ≈ New-SPConfigurationDatabase, helpcollections ≈
# Install-SPHelpCollection -All, secureresources ≈ Initialize-SPResourceSecurity,
# services ≈ Install-SPService, installfeatures ≈ Install-SPFeature
# -AllExistingFeatures, adminvs ≈ New-SPCentralAdministration, applicationcontent ≈
# Install-SPApplicationContent. (`security -installservices`, which used to stand
# here, is no psconfig verb at all.) Run as the domain Administrator, because
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
        @('-cmd', 'helpcollections', '-installall'),
        @('-cmd', 'secureresources'),
        @('-cmd', 'services', '-install'),
        @('-cmd', 'installfeatures'),
        @('-cmd', 'adminvs', '-provision', '-port', "$port", '-windowsauthprovider', 'onlyusewindowsauth'),
        @('-cmd', 'applicationcontent', '-install')
    )
    foreach ($command in $commands) {
        $code = Invoke-InstallStep -FilePath $psconfig -What ('psconfig ' + ($command -join ' ')) `
            -Arguments $command -Account $adminAccount -Password $config.admin_password `
            -TimeoutSeconds 3600 -AllowFailure
        if ($code -ne 0 -and $code -ne 3010) {
            Fail ('psconfig ' + ($command -join ' ') + ' failed (exit ' + $code + '): its output is in ' +
                'C:\ProgramData\OnTrak\logs')
        }
        if ($command[1] -eq 'configdb') {
            # Subscription Edition's documented step right after the configuration
            # database: Update-SPFlightsConfigFile points the flights file at the
            # binaries this install laid down. A farm cmdlet, so it runs as the
            # account that created the farm.
            $flights = Join-Path $env:CommonProgramFiles 'microsoft shared\Web Server Extensions\16\CONFIG\SPFlightRawConfig.json'
            Invoke-InstallStep -FilePath 'powershell.exe' -What 'Update-SPFlightsConfigFile' `
                -Arguments @('-NoProfile', '-NonInteractive', '-Command',
                    ('Add-PSSnapin Microsoft.SharePoint.PowerShell -ErrorAction SilentlyContinue; ' +
                        'Update-SPFlightsConfigFile -FilePath "' + $flights + '"')) `
                -Account $adminAccount -Password $config.admin_password `
                -TimeoutSeconds 600 | Out-Null
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
