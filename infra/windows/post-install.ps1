# post-install.ps1 — bake OnTrak settings into the golden Windows image.
#
# Run inside a freshly built Windows VM (infra/build-golden-image.sh does this for
# you, then publishes the result as the `ontrak-win-base` image). Everything here
# is applied BEFORE the image is published, so every clone inherits it:
#
#   * the training account, with the password from C:\ProgramData\OnTrak\config.json
#   * WinRM accepting that account with a full administrator token
#   * RDP enabled, so Guacamole can broker a browser session
#   * power settings that never sleep or blank the screen mid-exercise
#   * Defender exclusions for the fault-injection directories
#   * the Incus agent able to start on boot (for guest.driver=incus-exec)
#
# Readings the input:
#   C:\ProgramData\OnTrak\config.json  {"password": "...", "user": "student"}
#
# Emits ONTRAK-POSTINSTALL-OK on success so the build script can verify it.

$ErrorActionPreference = 'Continue'

$configPath = 'C:\ProgramData\OnTrak\config.json'
$markerChars = 'ONTRAK-POSTINSTALL-OK'

function Step { param([string] $Message) Write-Output ('[postinstall] ' + $Message) }
function StepFail { param([string] $Message) Write-Output ('[postinstall][error] ' + $Message) }

# --------------------------------------------------------------- credentials --
$userName = 'student'
$password = ''
if (Test-Path $configPath) {
    try {
        $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($config.user) { $userName = [string]$config.user }
        $password = [string]$config.password
    } catch {
        StepFail ('could not read ' + $configPath + ': ' + $_.Exception.Message)
    }
}
if ([string]::IsNullOrWhiteSpace($password)) {
    StepFail 'no training password supplied; the training account will not be created'
} else {
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $existing = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
    if ($existing) {
        Set-LocalUser -Name $userName -Password $secure -PasswordNeverExpires $true
        Step ('updated local user ' + $userName)
    } else {
        New-LocalUser -Name $userName -Password $secure -FullName 'Training User' `
            -Description 'OnTrak training account' -PasswordNeverExpires | Out-Null
        Step ('created local user ' + $userName)
    }
    Add-LocalGroupMember -Group 'Administrators' -Member $userName -ErrorAction SilentlyContinue
}

# ------------------------------------------------------- remoting and access ---
# WinRM: UAC remote restrictions otherwise strip the administrator token, and
# driver/settings scenarios need elevation to inject and repair faults.
New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' `
    -Name 'LocalAccountTokenFilterPolicy' -Value 1 -PropertyType DWord -Force | Out-Null
Step 'set LocalAccountTokenFilterPolicy=1 (full admin token over WinRM)'
#
# SECURITY NOTE: that setting means anyone who can reach WinRM with the training
# credentials is a full local administrator of that VM. Acceptable here only
# because student VMs sit on an isolated lab bridge, hold nothing of value, and
# are destroyed and re-cloned constantly. Do not reuse this image anywhere that
# matters. Prefer guest.driver=incus-exec (vsock, no network exposure) if your
# host supports it.

try { Enable-PSRemoting -SkipNetworkProfileCheck -Force | Out-Null; Step 'WinRM enabled' } catch { StepFail ('Enable-PSRemoting: ' + $_.Exception.Message) }

# RDP for the Guacamole console.
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' `
    -Name 'fDenyTSConnections' -Value 0 -Force
try {
    Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
    Step 'RDP enabled (fDenyTSConnections=0, Remote Desktop firewall group enabled)'
} catch { StepFail ('could not enable the RDP firewall rules: ' + $_.Exception.Message) }

# Windows 11 falls back to short-lived dynamic ports for RDP when this is
# mis-set; pin it so Guacamole's target port never moves.
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name 'PortNumber' -Value 3389 -Type DWord -Force

# Isolated lab networks should not raise "make this PC discoverable" prompts.
# The key always exists on Windows and New-Item -Force against it fails with
# "Attempted to perform an unauthorized operation" (its ACL denies key creation),
# which used to print an alarming error into every build log for a setting that
# was in fact applied. Set the value directly, and say so if even that is refused.
try {
    Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Network' `
        -Name 'NewNetworkWindowOff' -Value 1 -Force -ErrorAction Stop
    Step 'set NewNetworkWindowOff=1 (no discovery prompts on the lab network)'
} catch { StepFail ('could not set NewNetworkWindowOff: ' + $_.Exception.Message) }

# ------------------------------------------------------------------- power -----
powercfg -h off 2>$null
powercfg -change -monitor-timeout-ac 0 2>$null
powercfg -change -standby-timeout-ac 0 2>$null
powercfg -change -disk-timeout-ac 0 2>$null
Step 'power: hibernate off, display/sleep timeouts disabled'

# --------------------------------------------------------------- updates -------
# A training class should not be rebooted by Windows Update mid-exercise. The
# image is refreshed by re-running the golden image build instead.
try {
    Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
    Set-Service -Name wuauserv -StartupType Manual -ErrorAction SilentlyContinue
    Step 'Windows Update service set to Manual (lab image refresh is a rebuild)'
} catch { StepFail ('could not adjust wuauserv: ' + $_.Exception.Message) }

# --------------------------------------------------------------- defender ------
# Scenarios plant deliberately benign artifacts under these paths, and some
# (a script host "burning" CPU) look suspicious to a behavioural engine. Path
# exclusions keep the exercise deterministic.
foreach ($path in @('C:\ProgramData\OnTrak', 'C:\Users\Public\update')) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    try { Add-MpPreference -ExclusionPath $path -ErrorAction Stop; Step ('Defender exclusion: ' + $path) }
    catch { StepFail ('could not add Defender exclusion for ' + $path + ': ' + $_.Exception.Message) }
}
# Deliberately NOT excluding powershell.exe/wscript.exe: that would open an AMSI
# hole far wider than these scenarios need. If a specific scenario's artifact gets
# quarantined on your build, add a targeted -ExclusionProcess for it there.

# ------------------------------------------------------------ incus agent ------
# Only needed for guest.driver=incus-exec. Best effort: a VM using WinRM works
# without it, so a failure here is not fatal.
#
# Deliberately no `Restart-Service`. This script is normally applied *through*
# that same agent (WinRM is not listening until the Enable-PSRemoting above ran,
# so the agent is the only transport that works on a fresh guest), and restarting
# it tears down the very session running these commands: the build dies with
# "Lost connection to the event listener ... websocket: close 1006" part-way
# through, after a 40-minute install. Setting the startup type is what "able to
# start on boot" actually needs; the running service keeps running.
try {
    $service = Get-Service -Name 'Incus-Agent' -ErrorAction SilentlyContinue
    if ($service) {
        Set-Service -Name 'Incus-Agent' -StartupType Automatic -ErrorAction SilentlyContinue
        Step 'Incus-Agent service set to Automatic'
    } else {
        Step 'Incus-Agent service not present (fine for guest.driver=winrm)'
    }
} catch { StepFail ('Incus-Agent handling: ' + $_.Exception.Message) }

# ----------------------------------------------------------------- extras -------
# A note the student sees on the desktop, and a predictable place for notes.
$desktop = Join-Path $env:PUBLIC 'Desktop'
if (Test-Path $desktop) {
    Set-Content -Path (Join-Path $desktop 'README training machine.txt') -Encoding UTF8 -Value @'
OnTrak training machine
-------------------------
You are signed in as a training user on a disposable machine.

* Break it, fix it, reset it: nothing here is production.
* Resetting destroys this machine and gives you a clean one, so save your notes.
* Notes for graded objectives go to your own Desktop as ontrak-notes.txt.
'@
}

# The student's own desktop may not exist yet if the account was just created.
New-Item -ItemType Directory -Force -Path ("C:\Users\" + $userName + "\Desktop") | Out-Null

# ---------------------------------------------------------------- verify -------
Step ('user: ' + $userName)
Step ('RDP: ' + (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server').fDenyTSConnections)
Step ('Defender real-time: ' + (Get-MpComputerStatus -ErrorAction SilentlyContinue).RealTimeProtectionEnabled)

Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue
Write-Output $markerChars
