# exchange-server.ps1 — Exchange Server 2019 / Subscription Edition, on its own forest.
#
# Layered onto win2019/win2022 by the catalog entries exchange-server-2019 and
# exchange-server-se (catalog/server-products.yaml). Exchange is not a standalone
# product: it needs an Active Directory forest with an extended schema, and the
# account that extends it has to hold enterprise rights.
#
# Where that forest comes from is the interesting part. The Windows image this is
# layered onto is not sysprep'd, so every clone of it shares a machine SID and a domain
# *join* cannot be trusted (infra/build-golden-image.sh says so where it publishes the
# image). What a clone can do is become the first domain controller of a forest of its
# own, which is a domain with exactly one machine in it — and that is what this does,
# in this order:
#
#   1. set the built-in Administrator's password from the descriptor, while it is still
#      a local account (it is the only account a brand-new forest trusts with schema and
#      enterprise rights, and the base image's is whatever incus-windows chose);
#   2. promote the guest, ask for the reboot that finishes it, and resume here after;
#   3. `/PrepareSchema`, then `/PrepareAD`, then `/mode:Install /role:Mailbox`, all as
#      `<domain>\Administrator`.
#
# Each expensive step records that it finished, so a re-run after a reboot continues
# instead of extending a schema twice. Budget an hour: schema preparation and the role
# install are both long, and the setup logs under
# `C:\ExchangeSetupLogs` are the record of what happened — the process is started under
# another account, so Windows gives nothing to read back on the console.
#
# Not run against real media: no Exchange media ships here and no Windows VM runs in
# this checkout. See docs/roadmap.md for the honest label.

. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin
$config = Get-ProductConfig
if (-not $config.domain) { Fail 'the descriptor names no domain, and Exchange is a directory product' }

if (-not (Test-StepDone 'forest-promoted')) {
    Ensure-AdministratorPassword -Password $config.admin_password
}
Assert-Forest -Domain $config.domain -SafeModePassword $config.safe_mode_password
Wait-ForDirectory

$adminAccount = $config.domain + '\Administrator'
$media = Get-MediaFolder -Probe 'Setup.exe' -Folder $config.media_folder
$setup = Join-Path $media 'Setup.exe'
Step ('Exchange media: ' + $media + ' (version ' + $config.version + ')')

# The license-terms switch changed when Microsoft added the diagnostic-data choice:
# current media wants /IAcceptExchangeServerLicenseTerms_DiagnosticDataON and older
# images reject it as unknown. The fallback below is deliberately narrow — it is only
# tried when setup died inside five minutes, because that is what rejecting an argument
# looks like, and re-running a real 40-minute failure would be a waste of an hour.
$terms = '/IAcceptExchangeServerLicenseTerms_DiagnosticDataON'
$legacyTerms = '/IAcceptExchangeServerLicenseTerms'
$quickFailureSeconds = 300

function Invoke-ExchangeStep {
    param(
        [string] $Name,
        [string[]] $Arguments,
        [string] $StateName
    )
    if ($StateName -and (Test-StepDone $StateName)) {
        Step ('already done on an earlier pass: ' + $Name)
        return
    }
    $started = Get-Date
    $code = Invoke-InstallStep -FilePath $setup -What ('Exchange ' + $Name) -Arguments ($Arguments + @($terms)) `
        -Account $adminAccount -Password $config.admin_password -AllowFailure
    $seconds = [int] ((Get-Date) - $started).TotalSeconds
    if ($code -ne 0 -and $seconds -lt $quickFailureSeconds) {
        Step ('that failed in ' + $seconds + ' seconds, which is how older media rejects the ' +
            'license-terms switch: trying the older one')
        $code = Invoke-InstallStep -FilePath $setup -What ('Exchange ' + $Name + ' (legacy terms)') `
            -Arguments ($Arguments + @($legacyTerms)) `
            -Account $adminAccount -Password $config.admin_password -AllowFailure
    }
    if ($code -eq 3010) {
        if ($StateName) { Set-StepDone $StateName }
        Request-Reboot ('Exchange ' + $Name + ' asked for a restart')
    }
    if ($code -ne 0) {
        Fail ('Exchange ' + $Name + ' failed (exit ' + $code + '): read C:\ExchangeSetupLogs\ExchangeSetup.log, ' +
            'which is where the reason is')
    }
    if ($StateName) { Set-StepDone $StateName }
}

# /PrepareSchema first and on its own: it is the step that changes the directory's
# schema, and when it fails the log says which attribute it refused.
Invoke-ExchangeStep -Name 'PrepareSchema' -Arguments @('/PrepareSchema') -StateName 'schema-prepared'
Invoke-ExchangeStep -Name 'PrepareAD' -Arguments @('/PrepareAD', '/OrganizationName:' + $config.org) `
    -StateName 'ad-prepared'
Invoke-ExchangeStep -Name 'InstallMailboxRole' -Arguments @('/mode:Install', '/role:Mailbox') `
    -StateName 'mailbox-installed'

# -- verification --------------------------------------------------------------
# Services and the installed tree, not a mailbox round trip: reading mail needs the
# Exchange management shell in a fresh session, and what a *build* has to prove is that
# the product is installed, registered and running. A scenario's check script is where
# "can this mailbox send" belongs.
$expect = @('MSExchangeIS', 'MSExchangeTransport', 'MSExchangeServiceHost')
foreach ($name in $expect) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $service) { Fail ('Exchange reports success and there is no ' + $name + ' service') }
    if ($service.Status -ne 'Running') { Fail ($name + ' is installed and not running') }
    Step ($name + ' is running')
}

$installRoot = 'C:\Program Files\Microsoft\Exchange Server'
if (-not (Test-Path $installRoot)) {
    Fail ('no Exchange install tree under ' + $installRoot + ': the role install did not complete')
}
if (-not (Test-Path 'HKLM:\SOFTWARE\Microsoft\ExchangeServer')) {
    Fail 'Exchange left no registration in the registry'
}
Step 'the install tree and its registration are both in place'

Write-Output $productOkMarker
Write-Output ('exchange ' + $config.version + ' installed on ' + $config.domain)
