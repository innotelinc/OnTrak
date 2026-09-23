# lib.ps1 — what every product install script beside it expects to have.
#
# Dot-sourced by the scripts in this directory, and uploaded into the guest by
# `infra/build-workload-image.sh` along with the one it is running. Nothing here is
# product-specific: reading the descriptor, saying what is happening, finding the media
# the builder attached, failing loudly, and resuming after a reboot are the same for SQL
# Server as for Exchange.
#
# The contract, in one place (a product script never parses arguments; the builder writes
# the descriptor into the guest so that a re-run after a reboot needs no state on the
# host):
#
#   C:\ProgramData\OnTrak\product.json       what to install, and from where
#   C:\ProgramData\OnTrak\product-state.txt  every completed step, so a re-run after a
#                                            reboot continues instead of starting over
#   ONTRAK-PRODUCT-OK                        installed and verified
#   ONTRAK-PRODUCT-REBOOT                    the guest has to restart first
#   (neither marker)                         a step failed; the output says which one
#
# Like every guest script in this repository, this has been reviewed and parsed but not
# run against a real product install: no Windows media ships here. See
# docs/roadmap.md — the honest label is "built, but not proven on real hardware".

$productConfigPath = 'C:\ProgramData\OnTrak\product.json'
$productStatePath = 'C:\ProgramData\OnTrak\product-state.txt'
$productOkMarker = 'ONTRAK-PRODUCT-OK'
$productRebootMarker = 'ONTRAK-PRODUCT-REBOOT'

function Step { param([string] $Message) Write-Output ('[product] ' + $Message) }
function StepFail { param([string] $Message) Write-Output ('[product][error] ' + $Message) }

# Fail loudly and stop. A product install is a sequence of expensive steps (schema
# preparation, a 40-minute setup, a farm creation) and carrying on past a failed one
# produces a machine that looks installed and is not: better a stopped build with the
# reason in its output than an image that lies.
function Fail {
    param([string] $Message)
    StepFail $Message
    exit 1
}

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail 'this script has to run as an administrator to install a product'
    }
}

function Get-ProductConfig {
    if (-not (Test-Path $productConfigPath)) {
        Fail ('no ' + $productConfigPath + ' — the builder writes it before it runs this script')
    }
    try {
        return Get-Content -Path $productConfigPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Fail ('could not read ' + $productConfigPath + ': ' + $_.Exception.Message)
    }
}

# -- resuming after a reboot ---------------------------------------------------
# The state file holds one step name per line: every step that *completed*. A step
# that is expensive or has to happen exactly once (forest promotion, schema
# preparation) checks it first, so the builder can restart the guest and run the
# script again without redoing — or half-redoing — what is already done.
#
# A list and not one word, because Microsoft's sequences reboot more than once:
# with only the newest step recorded, the pass after the third reboot re-ran steps
# one and two — an /PrepareSchema "extended twice" is exactly what this file exists
# to prevent.
function Test-StepDone {
    param([string] $Name)
    if (-not (Test-Path $productStatePath)) { return $false }
    $done = @(Get-Content -Path $productStatePath | ForEach-Object { $_.Trim() })
    return $done -contains $Name
}

function Set-StepDone {
    param([string] $Name)
    if (Test-StepDone $Name) { return }
    Add-Content -Path $productStatePath -Value $Name -Encoding ASCII
    Step ('done: ' + $Name)
}

# Ask the builder to restart the guest and come back. Emitting the marker is the whole
# request: the script exits 0 here and the rest of it runs on the next pass.
function Request-Reboot {
    param([string] $Why)
    Step ('a reboot is required: ' + $Why)
    Write-Output $productRebootMarker
    exit 0
}

# -- media ---------------------------------------------------------------------
# Two shapes, because the catalog declares two: an ISO the builder attaches as a
# CD-ROM, and an archive it pushes into the guest. For an ISO the drive letter is the
# guest's business (it already has one CD-ROM letter and the attach takes the next
# free one), so the drive is found by what is *on* it — a probe file that only this
# product's media carries.
function Get-MediaFolder {
    param(
        [string] $Probe = 'setup.exe',
        [string] $Folder = ''
    )
    # An archive the builder pushed is unpacked at a path the descriptor names; an ISO
    # is not a path at all (it is a drive), so `Folder` is empty for those and the
    # search below is the whole story.
    if ($Folder) {
        if (Test-Path (Join-Path $Folder $Probe)) { return $Folder }
        if (Test-Path $Folder) { return $Folder }
        Fail ('the media the builder placed at ' + $Folder + ' is not there')
    }
    $candidates = @()
    try {
        $candidates = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 5' |
            ForEach-Object { $_.DeviceID + '\' })
    } catch {
        Fail ('could not list the guest''s CD-ROM drives: ' + $_.Exception.Message)
    }
    foreach ($drive in $candidates) {
        if (Test-Path (Join-Path $drive $Probe)) { return $drive }
    }
    Fail ('no attached CD-ROM carries ' + $Probe + ': the builder attaches the product''s ' +
        'media to this VM, so this means the attach failed, not that the media is missing')
}

# -- running the installers ----------------------------------------------------
# Setup executables in this family print progress and exit with a code that means
# something; a piped Start-Process would lose the output and a `&` call would leave
# the exit code to the caller to remember. This waits, streams, and reports both.
function Invoke-InstallStep {
    param(
        [string] $FilePath,
        [string[]] $Arguments,
        [int] $TimeoutSeconds = 5400,
        [string] $What = '',
        [string] $Account = '',
        [string] $Password = '',
        [switch] $AllowFailure
    )
    $label = if ($What) { $What } else { Split-Path -Leaf $FilePath }
    Step ('running ' + $label + ' (this is the slow part)')
    Step ('  ' + $FilePath + ' ' + ($Arguments -join ' '))
    $started = Get-Date
    if ($Account) {
        # A different user, because the product's setup asks the *directory* for
        # permissions the machine's own accounts do not have (preparing an Exchange
        # schema, creating a SharePoint farm). Windows gives no way to read a process'
        # console output across a logon boundary, so the product's own logs are the
        # record of what happened — the exit code is what this can see.
        $secure = ConvertTo-SecureString $Password -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential($Account, $secure)
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Credential $credential -PassThru
    } else {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -NoNewWindow
    }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch { }
        Fail ($label + ' did not finish within ' + $TimeoutSeconds + ' seconds')
    }
    try {
        $code = $process.ExitCode
    } catch {
        Fail ($label + ' finished and its exit code could not be read: ' + $_.Exception.Message)
    }
    $seconds = [int] ((Get-Date) - $started).TotalSeconds
    if ($code -ne 0 -and $code -ne 3010) {
        # 3010 is "success, restart required" and Microsoft's installers mean it
        # literally: every other non-zero code is a failure whose reason is in the
        # product's own log.
        if ($AllowFailure) {
            StepFail ($label + ' exited with ' + $code + ' after ' + $seconds + ' seconds')
            return $code
        }
        Fail ($label + ' exited with ' + $code + ' after ' + $seconds + ' seconds')
    }
    Step ($label + ' finished (exit ' + $code + ', ' + $seconds + ' seconds)')
    return $code
}

function Get-WebResponseStatus {
    param([string] $Url, [int] $TimeoutSeconds = 30)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return [int] $response.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int] $_.Exception.Response.StatusCode }
        return 0
    }
}

# -- a forest for the products that need one -----------------------------------
# Exchange and SharePoint are domain products, and a domain is the one thing a clone
# of the golden image cannot have: the image is not sysprep'd, so clones share a
# machine SID and a domain *join* cannot be trusted (infra/build-golden-image.sh says
# so where it publishes the image). Promoted here, the guest is the first domain
# controller of a forest of its own — one machine, one domain, which is what a
# training range can honestly run.
function Ensure-AdministratorPassword {
    param([string] $Password)
    # The built-in Administrator is the only account a fresh forest trusts with
    # enterprise rights, and its password is whatever the base image happened to set.
    # Setting it here, from the descriptor, is what makes the domain products'
    # "prepare the directory" steps possible at all — and it happens *before* the
    # promotion, while the account is still a local one.
    if (-not $Password) { Fail 'the descriptor carries no admin_password' }
    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    Set-LocalUser -Name 'Administrator' -Password $secure -PasswordNeverExpires $true
    Step 'the built-in Administrator password is set from the descriptor'
}

# The computer's domain, asked of the machine rather than of the process: this
# script runs as SYSTEM over the agent, and USERDNSDOMAIN is a *logon* variable a
# non-interactive process does not reliably have. A wrong "no domain" here would
# fail a perfectly promoted guest on its very next pass.
function Get-ComputerDomain {
    try {
        $system = Get-CimInstance -ClassName Win32_ComputerSystem
        if ($system.PartOfDomain) { return [string] $system.Domain }
    } catch { }
    return ''
}

function Assert-Forest {
    param([string] $Domain, [string] $SafeModePassword)
    $existing = Get-ComputerDomain
    if ($existing) {
        Step ('this guest is already in the ' + $existing + ' domain')
        return
    }
    if (Test-StepDone 'forest-promoted') {
        # Promoted on an earlier pass; the reboot is what made the domain live.
        Fail ('the forest was promoted on an earlier pass but the guest still has no domain: ' +
            'the reboot did not complete the promotion, so nothing after this can work')
    }
    if (-not $Domain) { Fail 'this product needs an AD forest and the descriptor names no domain' }
    if (-not $SafeModePassword) { Fail 'the descriptor carries no directory-services safe-mode password' }

    Step ('promoting this guest to the first domain controller of ' + $Domain)
    $feature = Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools
    if (-not $feature.Success) { Fail 'the AD DS role would not install' }

    $netbios = ($Domain -split '\.')[0].ToUpper()
    $secure = ConvertTo-SecureString $SafeModePassword -AsPlainText -Force
    Import-Module ADDSDeployment
    # -NoRebootOnCompletion, deliberately: the reboot is the builder's to do, and it is
    # what makes the *next* pass run with a domain instead of racing a shutdown.
    $result = Install-ADDSForest -DomainName $Domain -DomainNetbiosName $netbios `
        -SafeModeAdministratorPassword $secure -InstallDns -NoRebootOnCompletion `
        -Force -Confirm:$false
    if ($null -eq $result) { Fail 'the forest promotion returned nothing to report' }

    Set-StepDone 'forest-promoted'
    Request-Reboot 'the promotion finishes when the guest comes back up'
}

# Waits for the directory to answer after a promotion, so the product's own setup does
# not start against a domain controller that is still coming up.
function Wait-ForDirectory {
    param([int] $TimeoutSeconds = 600)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $service = Get-Service -Name NTDS -ErrorAction Stop
            if ($service.Status -eq 'Running') {
                Step 'the directory service is running'
                return
            }
        } catch { }
        Start-Sleep -Seconds 10
    }
    Fail 'the directory service never started on this guest'
}

# Creates a farm/service account and the SQL login it needs. SharePoint's own setup
# wants the account to exist before it runs, and SQL Server's PowerShell module is not
# part of a SQL install, so the login is created over ADO.NET — the same System.Data
# client every Windows guest already has.
function New-SqlLogin {
    param(
        [string] $Instance = 'localhost',
        [string] $Account,
        [string] $Password,
        [string[]] $Roles = @('securityadmin', 'dbcreator')
    )
    $connection = New-Object System.Data.SqlClient.SqlConnection
    $connection.ConnectionString = ('Server=' + $Instance + ';Integrated Security=True;' +
        'TrustServerCertificate=True;Connect Timeout=30')
    try {
        $connection.Open()
        foreach ($role in $Roles) {
            $sql = 'IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @account) ' +
                'BEGIN CREATE LOGIN [' + $Account + '] WITH PASSWORD = @password; END; ' +
                'ALTER SERVER ROLE [' + $role + '] ADD MEMBER [' + $Account + '];'
            $command = $connection.CreateCommand()
            $command.CommandText = $sql
            $command.Parameters.AddWithValue('@account', $Account) | Out-Null
            $command.Parameters.AddWithValue('@password', $Password) | Out-Null
            $command.ExecuteNonQuery() | Out-Null
            Step ('granted the ' + $role + ' role to ' + $Account)
        }
    } catch {
        Fail ('could not create the SQL login for ' + $Account + ': ' + $_.Exception.Message)
    } finally {
        $connection.Close()
    }
}

function New-LocalAccount {
    param([string] $Account, [string] $Password)
    $existing = Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    if ($existing) {
        Set-LocalUser -Name $Account -Password $secure -PasswordNeverExpires $true
    } else {
        New-LocalUser -Name $Account -Password $secure -PasswordNeverExpires $true `
            -Description 'OnTrak farm account' | Out-Null
    }
    Add-LocalGroupMember -Group 'Administrators' -Member $Account -ErrorAction SilentlyContinue
    Step ('local account ready: ' + $Account)
}
