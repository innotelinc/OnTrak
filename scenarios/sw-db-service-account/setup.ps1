# sw-db-service-account — the service account no longer authenticates.
#
# The mechanism password rotations really break: Windows services hold their
# account's password *at the service*. Rotate the account and not the service,
# and the service stops starting at all (System log, error 1069, "logon
# failure") — every client then reports "cannot connect to the database" while
# the database itself was never the problem.
#
# Here the SQL Server service is moved onto a local account (svc-sql), that
# account's password is rotated out from under it, and the service is left
# stopped but set to start automatically.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'MSSQLSERVER'
$breakAccount = 'svc-sql'

# Both passwords are generated, never written down (the same pattern as
# sec-malware-persistence): this repository's secret scanner refuses
# credential-shaped literals outright, and a training fault has no business
# carrying a password in a git history anyway. The values never matter — the
# fault is that the service holds a password *nobody* knows.
$passwordAlphabet = [char[]] 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$oldPassword = (-join ($passwordAlphabet | Get-Random -Count 14)) + (([char[]] '!#%+*') | Get-Random)
$rotatedPassword = (-join ($passwordAlphabet | Get-Random -Count 14)) + (([char[]] '!#%+*') | Get-Random)

# ------------------------------------------------------------- the account ---
# A local account, as the withdrawn vendor integration used. Created if missing,
# so re-running setup on a rebuilt template is a no-op rather than an error.
if (-not (Get-LocalUser -Name $breakAccount -ErrorAction SilentlyContinue)) {
    $secure = ConvertTo-SecureString $oldPassword -AsPlainText -Force
    New-LocalUser -Name $breakAccount -Password $secure -PasswordNeverExpires `
        -UserMayNotChangePassword -ErrorAction Stop | Out-Null
    Write-OnTrakStep ('created the local account ' + $breakAccount)
}

# --------------------------------------------------- the service, broken ------
# sc.exe is the documented way to set a service's logon *and* its password
# together (Set-Service cannot set the password), and setting them together is
# what makes the first half work before the rotation breaks it.
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
& sc.exe config $serviceName obj= ('.\' + $breakAccount) password= $oldPassword | Out-Null
& sc.exe config $serviceName start= auto | Out-Null

# ...and Saturday's rotation changes the account's password. The service still
# holds the old one, which is the whole fault.
& net user $breakAccount $rotatedPassword | Out-Null

# One start attempt, so the failure is real and the System log carries the 1069
# the write-up is meant to cite.
Start-Service -Name $serviceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Write-OnTrakStep 'the service now holds a password the account no longer has'

# ------------------------------------------------------------- assertions ----
Require-OnTrak 'the service is configured for the rotated account' {
    $svc = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $serviceName + "'")
    $svc.StartName -like ('*' + $breakAccount + '*')
}
Require-OnTrak 'the logon failure is observable: the service will not start' {
    (Get-OnTrakServiceState $serviceName) -ne 'Running'
}

Write-OnTrakSetupOk -Note ('service account ' + $breakAccount + ' rotated under the service')
