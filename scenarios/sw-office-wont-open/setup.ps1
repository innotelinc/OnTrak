# sw-office-wont-open — the launcher service behind the whole suite, knocked out.
#
# The trap is scale: every app in the suite fails identically, which reads like
# "Office is broken" and drives the repair install suggested in the ticket
# thread. The suite is one click-to-run installation behind one Windows service
# — Microsoft Office Click-to-Run Service (ClickToRunSvc) — and every app start
# goes through it. Stopped and disabled, the apps all die at the splash screen
# with the same generic error, which is exactly the story.
#
# The observable is the honest one: creating Word's automation object is what a
# launch *is* underneath, and (unlike a process check — an error dialog is a
# process too) it only succeeds when the app genuinely comes up.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$serviceName = 'ClickToRunSvc'

# ------------------------------------------- first-run noise out of the way ---
# The graded probe automates a real Office app, and a first-run wizard would sit
# in front of it measuring a wizard instead of this fault. The unattended-
# deployment values suppress first run and boot-to-Office-start machine-wide,
# for the probed account and for the student alike.
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\General' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\General' -Name 'ShownFirstRunOptin' -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\General' -Name 'DisableBootToOfficeStart' -PropertyType DWord -Value 1 -Force | Out-Null
New-Item -Path 'HKCU:\Software\Microsoft\Office\16.0\Common\General' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Office\16.0\Common\General' -Name 'ShownFirstRunOptin' -PropertyType DWord -Value 1 -Force | Out-Null

# The image's own half of the contract, proved before anything is broken: if
# this image cannot start Word at all, the fault below is measuring the image
# and the template build must stop here.
Require-OnTrak 'the image can start an Office app before the fault lands' {
    Test-OnTrakComLaunch -ProgId 'Word.Application'
}

# ------------------------------------------------------------- the fault ----
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
Write-OnTrakStep ('the weekend inventory agent left ' + $serviceName + ' stopped and disabled')

# ---------------------------------------------------------- assertions ------
Require-OnTrak 'the launcher service is stopped and disabled' {
    (Get-OnTrakServiceState $serviceName) -ne 'Running'
}
Require-OnTrak 'the fault is observable: an Office app no longer starts' {
    -not (Test-OnTrakComLaunch -ProgId 'Word.Application')
}

Write-OnTrakSetupOk -Note 'the click-to-run launcher is disabled and stopped behind a suite that all fails alike'
