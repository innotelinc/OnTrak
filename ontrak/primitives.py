"""Fault primitives: the building blocks scenario generation composes.

A primitive is a small, self-contained fault with its own setup PowerShell, its
own grading PowerShell and its own objectives. Generation is then just plumbing:
pick one or more primitives, write ``scenario.yaml`` + ``setup.ps1`` + ``check.ps1``,
and validate the result against the same contract a hand-written scenario obeys.

Why primitives instead of a generic "mutate something" generator: the interesting
part of a support scenario is not the mutation, it is (a) the fault being plausible
and reversible, and (b) the check reading live state so *any* correct fix passes.
Encoding that knowledge once per fault, and composing, keeps generated scenarios
as good as hand-written ones.

Adding a primitive is a code change, deliberately: a primitive carries the grading
logic that decides whether a student's fix works, and that deserves review.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Category


@dataclass
class Objective:
    id: str
    text: str
    weight: float = 1.0
    critical: bool = False


@dataclass
class FaultPrimitive:
    id: str
    label: str
    category: str
    title: str
    briefing: str
    objectives: list[Objective]
    setup_ps: str
    check_ps: str
    difficulty: int = 2
    minutes: int = 20
    hints: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    requires_internet: bool = False
    devices: list[str] = field(default_factory=list)
    notes: str = ""
    # PowerShell that proves the fault is observable in the guest, emitted into
    # setup.ps1 by the generator. This is what makes a generated scenario as
    # trustworthy as a hand-written one: `setup_ps` describes the attempt, and an
    # attempt that silently does nothing would otherwise reach a student as a ticket
    # with no fault behind it -- and a grader that passes them for doing nothing.
    assert_ps: str = ""

    @property
    def category_label(self) -> str:
        return Category(self.category).value


def _p(*args, **kwargs) -> FaultPrimitive:
    return FaultPrimitive(*args, **kwargs)


# --------------------------------------------------------------------------- #
# network
# --------------------------------------------------------------------------- #

PRIMITIVES: dict[str, FaultPrimitive] = {}


def primitive(**kwargs):
    """Register a primitive in the global table."""
    obj = _p(**kwargs)
    PRIMITIVES[obj.id] = obj
    return obj


primitive(
    id="dns-resolver-trapped",
    label="DNS pointed at a dead resolver",
    category=Category.NETWORK.value,
    title="Intranet names stopped resolving",
    briefing=(
        "A colleague \"tidied up\" the network settings on this machine this morning. "
        "Since then nothing on the intranet resolves, although the network itself looks "
        "connected and colleagues are fine."
    ),
    objectives=[
        Objective("dns-restore-resolver", "Client is using a working DNS resolver", 3, critical=True),
        Objective("dns-resolve-intranet", "Intranet name fileserver.ontrak.lab resolves", 2),
        Objective("dns-reach-service", "The intranet service is actually reachable", 1),
    ],
    setup_ps="""$bogusDns = '10.20.0.99'
$adapter = Get-OnTrakPrimaryAdapterName
if (-not $adapter) {
    Write-OnTrakStep 'no active adapter; DNS fault not applied'
} else {
    Write-OnTrakStep ("pointing DNS on '" + $adapter + "' at " + $bogusDns)
    Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $bogusDns -ErrorAction SilentlyContinue
    try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }
    Write-OnTrakStep ("intranet lookup works after fault: " + (Test-OnTrakDnsName -Name 'fileserver.ontrak.lab'))
}""",
    assert_ps="""Require-OnTrak 'there is an active adapter to break' { [bool](Get-OnTrakPrimaryAdapterName) }
Require-OnTrak 'the adapter resolves through the dead resolver 10.20.0.99' {
    (Get-OnTrakDnsServerAddress -InterfaceAlias (Get-OnTrakPrimaryAdapterName)) -contains '10.20.0.99'
}
Require-OnTrak 'the intranet name no longer resolves' {
    -not (Test-OnTrakDnsName -Name 'fileserver.ontrak.lab')
}""",
    check_ps="""$bogusDns = '10.20.0.99'
$adapter = Get-OnTrakPrimaryAdapterName
$servers = @(Get-OnTrakDnsServerAddress -InterfaceAlias $adapter)
$serversText = if ($servers.Count -gt 0) { $servers -join ', ' } else { 'none configured (DHCP)' }
$resolves = Test-OnTrakDnsName -Name 'fileserver.ontrak.lab'
$reachable = Test-OnTrakTcpPort -ComputerName 'fileserver.ontrak.lab' -Port 80

Add-OnTrakCheck -Objective 'dns-restore-resolver' `
    -Passed ((-not ($servers -contains $bogusDns)) -and $resolves) `
    -Detail ("adapter=" + $adapter + "; resolvers=" + $serversText + "; lookup works=" + $resolves)
Add-OnTrakCheck -Objective 'dns-resolve-intranet' -Passed $resolves `
    -Detail ("Resolve-DnsName fileserver.ontrak.lab -> " + $resolves)
Add-OnTrakCheck -Objective 'dns-reach-service' -Passed $reachable `
    -Detail ("TCP fileserver.ontrak.lab:80 -> " + $reachable)""",
    difficulty=2,
    minutes=20,
    hints=[
        "Compare the adapter's settings with a working machine before changing anything.",
        "A resolver that does not answer looks identical to a resolver that does not exist.",
        "Check both the DNS servers and whether the name actually resolves afterwards.",
    ],
    tags=["dns", "network"],
)

primitive(
    id="proxy-hijacked",
    label="Browser and WinHTTP proxy pointed at a dead host",
    category=Category.NETWORK.value,
    title="\"The internet is down\" — but only in browsers",
    briefing=(
        "The user says the internet is broken. Pings work and the intranet is fine, "
        "but every browser page times out. A proxy configuration was pushed by an "
        "old management agent that no longer exists."
    ),
    objectives=[
        Objective("proxy-restore-browser", "The per-user proxy configuration is cleared", 3, critical=True),
        Objective("proxy-restore-winhttp", "The machine-level WinHTTP proxy is cleared", 2),
        Objective("proxy-intranet-reachable", "Intranet access works again", 1),
    ],
    setup_ps="""$deadProxy = '10.20.0.98:8080'
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Write-OnTrakStep ("setting browser proxy to " + $deadProxy)
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name ProxyServer -Value $deadProxy -Type String
Set-ItemProperty -Path $key -Name ProxyOverride -Value '<-loopback>' -Type String
Write-OnTrakStep ("setting WinHTTP proxy to " + $deadProxy)
netsh winhttp set proxy $deadProxy | Out-Null""",
    assert_ps="""Require-OnTrak 'the browser proxy points at a host that does not exist' {
    (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' `
        -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer -eq '10.20.0.98:8080'
}
Require-OnTrak 'the machine-wide WinHTTP proxy is set' {
    ((netsh winhttp show proxy) -join ' ') -notmatch 'Direct access'
}""",
    check_ps="""$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$enable = 1
$server = ''
try { $enable = (Get-ItemProperty -Path $key -Name ProxyEnable -ErrorAction Stop).ProxyEnable } catch { }
try { $server = [string](Get-ItemProperty -Path $key -Name ProxyServer -ErrorAction Stop).ProxyServer } catch { }
$winhttp = (netsh winhttp show proxy) -join ' '
$winhttpClear = ($winhttp -match 'Direct access' -or $winhttp -match 'no proxy server')
$intranet = Test-OnTrakTcpPort -ComputerName 'fileserver.ontrak.lab' -Port 80

Add-OnTrakCheck -Objective 'proxy-restore-browser' `
    -Passed ((-not $enable) -or [string]::IsNullOrWhiteSpace($server)) `
    -Detail ("ProxyEnable=" + $enable + "; ProxyServer='" + $server + "'")
Add-OnTrakCheck -Objective 'proxy-restore-winhttp' -Passed $winhttpClear `
    -Detail ("netsh winhttp show proxy -> " + $winhttp)
Add-OnTrakCheck -Objective 'proxy-intranet-reachable' -Passed $intranet `
    -Detail ("TCP fileserver.ontrak.lab:80 -> " + $intranet)""",
    difficulty=2,
    minutes=20,
    hints=[
        "Ping works but the browser does not: that rules out the link and points above it.",
        "Browsers and Windows components do not always share the same proxy settings.",
        "There is a command that shows the machine-wide proxy without opening a browser.",
    ],
    tags=["proxy", "network", "browser"],
)

primitive(
    id="gateway-misconfigured",
    label="Static default gateway that does not exist",
    category=Category.NETWORK.value,
    title="Subnet works, everything outside it does not",
    briefing=(
        "A static address was configured for a visiting laptop. It can reach machines "
        "on the same subnet but nothing beyond it."
    ),
    objectives=[
        Objective("gateway-restore", "A working default gateway is configured", 3, critical=True),
        Objective("gateway-outside-reachable", "A host outside the subnet is reachable", 2),
    ],
    setup_ps="""$bogusGateway = '10.20.0.254'
$adapter = Get-OnTrakPrimaryAdapterName
if (-not $adapter) {
    Write-OnTrakStep 'no active adapter; gateway fault not applied'
} else {
    Write-OnTrakStep ("removing routes and setting default gateway " + $bogusGateway)
    Remove-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
    New-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -NextHop $bogusGateway -ErrorAction SilentlyContinue
    Write-OnTrakStep ("outside reachable after fault: " + (Test-OnTrakDefaultGatewayReachable))
}""",
    assert_ps="""Require-OnTrak 'there is an active adapter to re-address' { [bool](Get-OnTrakPrimaryAdapterName) }
Require-OnTrak 'the default gateway is the non-existent 10.20.0.254' {
    @(Get-NetRoute -InterfaceAlias (Get-OnTrakPrimaryAdapterName) -DestinationPrefix '0.0.0.0/0' `
        -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -eq '10.20.0.254' }).Count -gt 0
}
Require-OnTrak 'off-subnet destinations are unreachable' {
    -not (Test-OnTrakDefaultGatewayReachable)
}""",
    check_ps="""$adapter = Get-OnTrakPrimaryAdapterName
$route = Get-NetRoute -InterfaceAlias $adapter -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue
$nextHops = @($route | ForEach-Object { $_.NextHop })
$reachable = Test-OnTrakDefaultGatewayReachable

Add-OnTrakCheck -Objective 'gateway-restore' `
    -Passed (($nextHops.Count -gt 0) -and $reachable) `
    -Detail ("interface=" + $adapter + "; default next hops=" + ($nextHops -join ', '))
Add-OnTrakCheck -Objective 'gateway-outside-reachable' -Passed $reachable `
    -Detail ("outside the subnet reachable -> " + $reachable)""",
    difficulty=3,
    minutes=25,
    hints=[
        "Compare the routing table with a working machine.",
        "A gateway address can be syntactically valid and still not exist.",
    ],
    requires_internet=True,
    tags=["routing", "gateway", "network"],
)

# --------------------------------------------------------------------------- #
# software
# --------------------------------------------------------------------------- #

primitive(
    id="service-disabled",
    label="Print spooler disabled and stopped",
    category=Category.SOFTWARE.value,
    title="Nobody can print from this machine",
    briefing=(
        "Printing stopped working after an \"optimisation\" pass. The print queue is "
        "empty, printers appear offline, and no error is shown."
    ),
    objectives=[
        Objective("spooler-start", "The print spooler service is running", 3, critical=True),
        Objective("spooler-autostart", "The print spooler starts automatically again", 2),
    ],
    setup_ps="""$service = 'Spooler'
Write-OnTrakStep ("stopping and disabling " + $service)
try { Stop-Service -Name $service -Force -ErrorAction SilentlyContinue } catch { }
Set-Service -Name $service -StartupType Disabled -ErrorAction SilentlyContinue
Write-OnTrakStep ("service state after fault: " + (Get-OnTrakServiceState -Name $service))""",
    assert_ps="""Require-OnTrak 'the print spooler is not running' {
    (Get-OnTrakServiceState -Name 'Spooler') -ne 'Running'
}
Require-OnTrak 'the print spooler will not come back on boot either' {
    "$((Get-Service -Name 'Spooler' -ErrorAction SilentlyContinue).StartType)" -eq 'Disabled'
}""",
    check_ps="""$service = 'Spooler'
$state = Get-OnTrakServiceState -Name $service
$running = ($state -eq 'Running')
$automatic = $false
try {
    $mode = (Get-Service -Name $service -ErrorAction Stop).StartType
    $automatic = ("$mode" -eq 'Automatic') -or ("$mode" -eq 'Manual')
} catch { }
Add-OnTrakCheck -Objective 'spooler-start' -Passed $running `
    -Detail ("Get-Service Spooler -> " + $state)
Add-OnTrakCheck -Objective 'spooler-autostart' -Passed $automatic `
    -Detail ("start type -> " + (Get-Service -Name $service -ErrorAction SilentlyContinue).StartType)""",
    difficulty=1,
    minutes=12,
    hints=[
        "The symptom points at a subsystem, not at an individual printer.",
        "Check the service's start type as well as whether it is running.",
    ],
    tags=["services", "printing"],
)

primitive(
    id="app-config-corrupt",
    label="Application configuration file corrupted",
    category=Category.SOFTWARE.value,
    title="An in-house tool will not start after an update",
    briefing=(
        "The reporting tool stopped launching after an automatic update. Windows shows "
        "a generic crash with no detail, and it works fine for colleagues."
    ),
    objectives=[
        Objective("config-repaired", "The configuration file is valid again", 3, critical=True),
        Objective("app-launches", "The application starts without crashing", 2),
        Objective("config-backup-kept", "The original broken file was preserved for the vendor", 1),
    ],
    setup_ps="""$appDir = Join-Path $env:ProgramData 'OnTrak\\Apps\\Reporter'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
$config = Join-Path $appDir 'reporter.config.json'
New-OnTrakFile -Path $config -Content '{"version": "3.2.1", "database": {'
Write-OnTrakStep ("corrupted config written to " + $config)""",
    assert_ps="""Require-OnTrak 'the configuration file is on disk' {
    Test-OnTrakFileExists -Path (Join-Path $env:ProgramData 'OnTrak\\Apps\\Reporter\\reporter.config.json')
}
Require-OnTrak 'the configuration file no longer parses' {
    $parsed = $null
    try {
        $parsed = Get-Content -Path (Join-Path $env:ProgramData 'OnTrak\\Apps\\Reporter\\reporter.config.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch { $parsed = $null }
    $null -eq $parsed
}""",
    check_ps="""$appDir = Join-Path $env:ProgramData 'OnTrak\\Apps\\Reporter'
$config = Join-Path $appDir 'reporter.config.json'
$valid = $false
if (Test-OnTrakFileExists -Path $config) {
    try {
        $raw = Get-Content -Path $config -Raw -ErrorAction Stop
        $null = $raw | ConvertFrom-Json -ErrorAction Stop
        $valid = $true
    } catch { $valid = $false }
}
$backup = @(Get-ChildItem -Path $appDir -Filter '*reporter.config*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'reporter.config.json' }).Count -gt 0
Add-OnTrakCheck -Objective 'config-repaired' -Passed $valid `
    -Detail ("config parses as JSON -> " + $valid)
Add-OnTrakCheck -Objective 'app-launches' -Passed $valid `
    -Detail "the tool starts only with a parseable configuration"
Add-OnTrakCheck -Objective 'config-backup-kept' -Passed $backup `
    -Detail ("a copy of the broken config exists -> " + $backup)""",
    difficulty=2,
    minutes=20,
    hints=[
        "Read the file before touching it; the breakage is usually obvious at the end.",
        "Preserve the broken copy — the vendor will ask for it.",
    ],
    tags=["configuration", "applications"],
)

# --------------------------------------------------------------------------- #
# os
# --------------------------------------------------------------------------- #

primitive(
    id="disk-space-exhausted",
    label="System disk nearly full",
    category=Category.OS.value,
    title="The machine is running out of disk space",
    briefing=(
        "The user cannot save files and Windows keeps warning about low disk space. "
        "Nothing was deliberately installed recently."
    ),
    objectives=[
        Objective("disk-space-recovered", "Free space on the system disk is healthy again", 3, critical=True),
        Objective("space-hog-removed", "The file filling the disk has been dealt with", 2),
    ],
    setup_ps="""$hogDir = Join-Path $env:ProgramData 'OnTrak\\Apps\\Cache'
New-Item -ItemType Directory -Path $hogDir -Force | Out-Null
$hog = Join-Path $hogDir 'cache.bin'
$targetMb = 4096
Write-OnTrakStep ("writing " + $targetMb + " MB cache file to " + $hog)
$fs = New-Object System.IO.FileStream($hog, [System.IO.FileMode]::Create)
try {
    $fs.SetLength($targetMb * 1MB)
} finally { $fs.Dispose() }
$free = Get-OnTrakFreeDiskGB
Write-OnTrakStep ("free space after fault: " + $free + " GB")""",
    assert_ps="""Require-OnTrak 'the cache file is filling the system disk' {
    Test-OnTrakFileExists -Path (Join-Path $env:ProgramData 'OnTrak\\Apps\\Cache\\cache.bin')
}
Require-OnTrak 'the system disk is low enough for the ticket to be real' { (Get-OnTrakFreeDiskGB) -lt 8 }""",
    check_ps="""$hog = Join-Path $env:ProgramData 'OnTrak\\Apps\\Cache\\cache.bin'
$free = Get-OnTrakFreeDiskGB
$hogExists = Test-OnTrakFileExists -Path $hog
Add-OnTrakCheck -Objective 'disk-space-recovered' -Passed ($free -gt 4) `
    -Detail ("free space on system disk: " + $free + " GB (need > 4)")
Add-OnTrakCheck -Objective 'space-hog-removed' -Passed (-not $hogExists) `
    -Detail ("4 GB cache file still present -> " + $hogExists)""",
    difficulty=2,
    minutes=18,
    hints=[
        "Find what is using the space before deleting anything.",
        "The user's own files are not the culprit.",
    ],
    tags=["disk", "performance"],
)

primitive(
    id="startup-bloat",
    label="Unwanted startup entries and a logon task",
    category=Category.OS.value,
    title="Boot takes several minutes",
    briefing=(
        "The machine has become slow to log in. It used to be fine; an assistant "
        "\"installed a few helpers\" last week."
    ),
    objectives=[
        Objective("startup-runkeys-cleared", "The unwanted Run entries are gone", 3, critical=True),
        Objective("startup-task-removed", "The unwanted logon task is gone", 2),
        Objective("startup-trace-documented", "What was removed is recorded for the ticket", 1),
    ],
    setup_ps="""$entries = @{
    'OneDriveBoost'  = 'C:\\ProgramData\\OnTrak\\Apps\\boost.exe'
    'PDFSaverHelper' = 'C:\\ProgramData\\OnTrak\\Apps\\pdfsaver.exe'
    'VendorUpdater'  = 'C:\\ProgramData\\OnTrak\\Apps\\updater.exe'
}
foreach ($name in $entries.Keys) {
    Write-OnTrakStep ("adding Run entry " + $name)
    Set-OnTrakRunKeyValue -Name $name -Value $entries[$name]
}
Write-OnTrakStep 'registering logon scheduled task OnTrakVendorAgent'
Start-OnTrakProcess -CommandLine 'schtasks /Create /TN OnTrakVendorAgent /SC ONLOGON /TR "C:\\ProgramData\\OnTrak\\Apps\\updater.exe" /F'""",
    assert_ps="""Require-OnTrak 'the unwanted Run entries are in place' {
    @(@('OneDriveBoost', 'PDFSaverHelper', 'VendorUpdater') | Where-Object { -not (Get-OnTrakRunKeyValue -Name $_) }).Count -eq 0
}
Require-OnTrak 'the logon task is registered' {
    @(Get-OnTrakScheduledTask -Name 'OnTrakVendorAgent').Count -gt 0
}""",
    check_ps="""$expected = @('OneDriveBoost', 'PDFSaverHelper', 'VendorUpdater')
$remaining = @()
foreach ($name in $expected) {
    $value = Get-OnTrakRunKeyValue -Name $name
    if ($value) { $remaining += $name }
}
$task = Get-OnTrakScheduledTask -Name 'OnTrakVendorAgent'
$documented = Test-OnTrakReportField -Path (Join-Path $env:ProgramData 'OnTrak\\ticket-notes.txt') -Pattern 'OneDriveBoost|PDFSaverHelper|VendorUpdater'
Add-OnTrakCheck -Objective 'startup-runkeys-cleared' -Passed ($remaining.Count -eq 0) `
    -Detail ("remaining Run entries: " + (($remaining -join ', ') -replace '^$', 'none'))
Add-OnTrakCheck -Objective 'startup-task-removed' -Passed (-not $task) `
    -Detail ("logon task OnTrakVendorAgent still present -> " + [bool]$task)
Add-OnTrakCheck -Objective 'startup-trace-documented' -Passed $documented `
    -Detail ("ticket notes record the removed entries -> " + $documented)""",
    difficulty=2,
    minutes=22,
    hints=[
        "Startup items live in more than one place.",
        "The ticket's last requirement is documentation, not removal.",
    ],
    tags=["startup", "performance"],
)

# --------------------------------------------------------------------------- #
# hardware
# --------------------------------------------------------------------------- #

primitive(
    id="device-disabled",
    label="A device disabled in Device Manager",
    category=Category.HARDWARE.value,
    title="No sound, and the device shows a warning",
    briefing=(
        "Audio stopped working after a support visit. Device Manager shows the audio "
        "device with a disabled/error marker and no sound plays."
    ),
    objectives=[
        Objective("device-re-enabled", "The device is enabled again", 3, critical=True),
        Objective("device-healthy", "The device reports no problem code", 2),
    ],
    setup_ps="""$device = Get-OnTrakPnpDevice -Class 'MEDIA'
if (-not $device) {
    Write-OnTrakStep 'no media-class device found; hardware fault not applied'
} else {
    Write-OnTrakStep ("disabling device '" + $device.FriendlyName + "'")
    Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    Write-OnTrakStep ("device state after fault: " + (Get-PnpDevice -InstanceId $device.InstanceId).Status)
}""",
    assert_ps="""Require-OnTrak 'there is a media-class device to disable' {
    @(Get-PnpDevice -Class 'MEDIA' -ErrorAction SilentlyContinue |
        Where-Object { $_.Problem -ne 'CM_PROB_PHANTOM' }).Count -gt 0
}
Require-OnTrak 'a media-class device is now disabled' {
    @(Get-PnpDevice -Class 'MEDIA' -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -ne 'OK' -and $_.Problem -ne 'CM_PROB_PHANTOM' }).Count -gt 0
}""",
    check_ps="""$device = Get-OnTrakPnpDevice -Class 'MEDIA'
if (-not $device) {
    Add-OnTrakCheck -Objective 'device-re-enabled' -Passed $false -Detail 'no media-class device present in this guest'
    Add-OnTrakCheck -Objective 'device-healthy' -Passed $false -Detail 'no media-class device present in this guest'
} else {
    $enabled = ("$($device.Status)" -eq 'OK')
    $problem = (Get-PnpDevice -InstanceId $device.InstanceId -ErrorAction SilentlyContinue).ProblemCode
    Add-OnTrakCheck -Objective 'device-re-enabled' -Passed $enabled `
        -Detail ("device=" + $device.FriendlyName + "; status=" + $device.Status)
    Add-OnTrakCheck -Objective 'device-healthy' -Passed (($enabled) -and (-not $problem)) `
        -Detail ("ProblemCode=" + $problem)
}""",
    difficulty=2,
    minutes=18,
    hints=[
        "Device Manager tells you the error code if you look at the device's properties.",
        "Reinstalling the driver is not the first or fastest fix here.",
    ],
    tags=["drivers", "devices"],
    notes="The audio device is a stand-in for any media-class device present in the guest image.",
)

# --------------------------------------------------------------------------- #
# security
# --------------------------------------------------------------------------- #

primitive(
    id="malware-persistence",
    label="Simulated malware persistence and dropped payload",
    category=Category.SECURITY.value,
    title="A user opened an attachment and something is restarting itself",
    briefing=(
        "A user opened an unexpected invoice attachment. Now a process reappears after "
        "every restart, Windows Defender is off, and there is an unfamiliar file on disk. "
        "Treat the machine as compromised until proven otherwise."
    ),
    objectives=[
        Objective("persistence-removed", "The persistence entries are gone", 3, critical=True),
        Objective("protection-restored", "Real-time protection is enabled again", 3, critical=True),
        Objective("payload-removed", "The dropped payload is no longer present", 2),
        Objective("incident-documented", "The incident is documented for the ticket", 1),
    ],
    setup_ps="""# A simulation: nothing here leaves the isolated lab network, and the payload is a
# text file. The point is the process — recognise, contain, remove, document.
$payloadDir = Join-Path $env:ProgramData 'OnTrak\\Apps\\Vendor'
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
$payload = Join-Path $payloadDir 'invoice_8842.exe'
New-OnTrakFile -Path $payload -Content 'Simulated payload placeholder. Not executable.'
Write-OnTrakStep ("dropped simulated payload at " + $payload)

Set-OnTrakRunKeyValue -Name 'WindowsUpdateHelper' -Value ($payload + ' -silent')
Write-OnTrakStep 'added a Run key masquerading as a Windows update helper'
Start-OnTrakProcess -CommandLine 'schtasks /Create /TN WindowsUpdateCheck /SC ONLOGON /TR "rundll32.exe" /F'
Write-OnTrakStep 'registered a logon task that restarts the payload'

try {
    Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction Stop
    Write-OnTrakStep 'disabled Defender real-time monitoring'
} catch {
    Write-OnTrakStep ('could not change Defender state: ' + $_.Exception.Message)
}""",
    assert_ps="""Require-OnTrak 'the simulated payload is on disk' {
    Test-OnTrakFileExists -Path (Join-Path $env:ProgramData 'OnTrak\\Apps\\Vendor\\invoice_8842.exe')
}
Require-OnTrak 'the persistence run key is set' { [bool](Get-OnTrakRunKeyValue -Name 'WindowsUpdateHelper') }
Require-OnTrak 'the logon task is registered' {
    @(Get-OnTrakScheduledTask -Name 'WindowsUpdateCheck').Count -gt 0
}""",
    check_ps="""$runValue = Get-OnTrakRunKeyValue -Name 'WindowsUpdateHelper'
$task = Get-OnTrakScheduledTask -Name 'WindowsUpdateCheck'
$payload = Join-Path $env:ProgramData 'OnTrak\\Apps\\Vendor\\invoice_8842.exe'
$payloadPresent = Test-OnTrakFileExists -Path $payload
$protection = Test-OnTrakDefenderRealTime
$documented = Test-OnTrakReportField -Path (Join-Path $env:ProgramData 'OnTrak\\incident-notes.txt') -Pattern 'invoice_8842|WindowsUpdateHelper|persistence'

Add-OnTrakCheck -Objective 'persistence-removed' -Passed ((-not $runValue) -and (-not $task)) `
    -Detail ("Run value='" + $runValue + "'; logon task present=" + [bool]$task)
Add-OnTrakCheck -Objective 'protection-restored' -Passed $protection `
    -Detail ("Defender real-time monitoring enabled -> " + $protection)
Add-OnTrakCheck -Objective 'payload-removed' -Passed (-not $payloadPresent) `
    -Detail ("payload still on disk -> " + $payloadPresent)
Add-OnTrakCheck -Objective 'incident-documented' -Passed $documented `
    -Detail ("incident notes exist and reference the artefacts -> " + $documented)""",
    difficulty=4,
    minutes=40,
    hints=[
        "Contain first: stop it coming back before you delete anything.",
        "Persistence and protection are separate problems; fixing one does not fix the other.",
        "The ticket is not closed until the incident is written down.",
    ],
    tags=["malware", "incident-response", "investigation"],
    notes="Simulation only — the payload is a placeholder file and the network is isolated.",
)


# --------------------------------------------------------------------------- #
# database — SQL Server (composed against the sql-server-* workloads)
# --------------------------------------------------------------------------- #

# These speak T-SQL through Invoke-OnTrakSql, the scenario library's ADO.NET
# helper: the product build installs the SQLENGINE feature and no client tools,
# so sqlcmd is not there to reach for.

primitive(
    id="db-service-stopped",
    label="SQL Server service stopped and disabled",
    category=Category.SOFTWARE.value,
    title="The application cannot connect to the database server",
    briefing=(
        "The line-of-business application reports it cannot connect to the "
        "database server since this morning. The server itself is up and answers "
        "ping, and restarting the application changed nothing."
    ),
    objectives=[
        Objective("db-service-running", "The SQL Server service is running", 3, critical=True),
        Objective("db-service-autostart", "The SQL Server service starts automatically again", 2),
        Objective("db-query-answers", "The instance answers a query again", 1),
    ],
    setup_ps="""$serviceName = 'MSSQLSERVER'
Write-OnTrakStep ('stopping and disabling ' + $serviceName)
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue""",
    assert_ps="""Require-OnTrak 'the SQL Server service is not running' {
    (Get-OnTrakServiceState -Name 'MSSQLSERVER') -ne 'Running'
}
Require-OnTrak 'the fault is observable: the instance answers no query' {
    $answers = $true
    try { Invoke-OnTrakSql -Query 'SELECT 1' | Out-Null } catch { $answers = $false }
    -not $answers
}""",
    check_ps="""$serviceName = 'MSSQLSERVER'
$state = Get-OnTrakServiceState -Name $serviceName
Add-OnTrakCheck -Objective 'db-service-running' -Passed ($state -eq 'Running') -Detail ($serviceName + ' is ' + $state)
$startType = 'Missing'
try { $startType = '' + (Get-Service -Name $serviceName -ErrorAction Stop).StartType } catch { }
Add-OnTrakCheck -Objective 'db-service-autostart' -Passed ($startType -eq 'Automatic') -Detail ('startup type is ' + $startType)
$answers = $false
try { Invoke-OnTrakSql -Query 'SELECT 1' | Out-Null; $answers = $true } catch { }
Add-OnTrakCheck -Objective 'db-query-answers' -Passed $answers -Detail ('the instance answers a query: ' + $answers)""",
    difficulty=2,
    minutes=20,
    hints=[
        '"Cannot connect" is the client\'s description of anything. Check the state of the database service before the database itself.',
        "Both halves matter: the service running now, and its startup type back to automatic so the next restart is not this ticket again.",
    ],
    tags=["sql", "service"],
    notes=(
        "SQL-aware: grading speaks T-SQL through Invoke-OnTrakSql, the scenario "
        "lib's ADO.NET helper, because the product build ships no sqlcmd."
    ),
)

primitive(
    id="db-tcp-protocol-off",
    label="SQL Server's network protocol switched off",
    category=Category.NETWORK.value,
    title="The app server cannot reach the database — but it works on the box",
    briefing=(
        "The application server cannot reach the database since it was rebuilt "
        "this morning, while every tool run on the database box itself works "
        "fine. The network between the two servers is healthy."
    ),
    objectives=[
        Objective("db-tcp-enabled", "TCP/IP is enabled on the instance again", 3, critical=True),
        Objective("db-listener-answers", "The database port answers connections again", 2),
        Objective("db-app-can-connect", "A TCP connection can run a query again", 1),
    ],
    setup_ps="""$instanceMap = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
$instanceId = (Get-ItemProperty -Path $instanceMap -Name 'MSSQLSERVER' -ErrorAction Stop).MSSQLSERVER
$protocols = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instanceId + '\\MSSQLServer\\SuperSocketNetLib'
Write-OnTrakStep 'switching off TCP/IP (shared memory is always on, which is the trap)'
Set-ItemProperty -Path ($protocols + '\\Tcp') -Name 'Enabled' -Value 0 -Type DWord
Restart-Service -Name 'MSSQLSERVER' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3""",
    assert_ps="""Require-OnTrak 'TCP/IP is switched off' {
    $instanceMap = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
    $instanceId = (Get-ItemProperty -Path $instanceMap -Name 'MSSQLSERVER' -ErrorAction Stop).MSSQLSERVER
    $tcp = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instanceId + '\\MSSQLServer\\SuperSocketNetLib\\Tcp'
    ((Get-ItemProperty -Path $tcp -Name 'Enabled' -ErrorAction Stop).Enabled) -eq 0
}
Require-OnTrak 'the fault is observable: the database port answers nothing' {
    -not (Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 1433)
}""",
    check_ps="""$instanceMap = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
$instanceId = (Get-ItemProperty -Path $instanceMap -Name 'MSSQLSERVER' -ErrorAction Stop).MSSQLSERVER
$tcp = 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + $instanceId + '\\MSSQLServer\\SuperSocketNetLib\\Tcp'
$enabled = ((Get-ItemProperty -Path $tcp -Name 'Enabled' -ErrorAction Stop).Enabled)
Add-OnTrakCheck -Objective 'db-tcp-enabled' -Passed ($enabled -eq 1) -Detail ('TCP/IP enabled: ' + $enabled)
$listens = Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 1433
Add-OnTrakCheck -Objective 'db-listener-answers' -Passed $listens -Detail ('port 1433 accepts a connection: ' + $listens)
$answers = $false
try { Invoke-OnTrakSql -Server 'tcp:localhost,1433' -Query 'SELECT 1' | Out-Null; $answers = $true } catch { }
Add-OnTrakCheck -Objective 'db-app-can-connect' -Passed $answers -Detail ('a forced-TCP connection can run a query: ' + $answers)""",
    difficulty=3,
    minutes=25,
    hints=[
        "'It works when I test it' is the trap: a local tool rides shared memory and proves nothing about the network.",
        "The protocols load with the service — re-enabling them changes nothing until the SQL Server service is restarted.",
    ],
    tags=["sql", "network"],
    notes=(
        "Shared memory is left on deliberately: the graded connection forces "
        "'tcp:' into the data source so the local shortcut cannot fake a fix."
    ),
)

primitive(
    id="db-log-capped",
    label="Transaction log capped with no autogrowth",
    category=Category.OS.value,
    title="Saving records fails: the transaction log is full",
    briefing=(
        "The application cannot save anything and the error text is alarming. "
        "The server's disks disagree: the data drive has plenty of room."
    ),
    objectives=[
        Objective("db-can-save", "The application can write records again", 3, critical=True),
        Objective("db-log-can-grow", "The log can grow again (autogrowth on, or the cap lifted)", 2),
        Objective("db-log-has-room", "The transaction log has room in it again", 1),
    ],
    setup_ps="""$database = 'TrainingDB'
Write-OnTrakStep ('capping the transaction log of ' + $database + ' at 4 MB')
Invoke-OnTrakSql -Query ('IF DB_ID(''' + $database + ''') IS NULL EXEC(''CREATE DATABASE ' + $database + '')') | Out-Null
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' SET RECOVERY FULL') | Out-Null
Invoke-OnTrakSql -Database $database -Query @"
IF OBJECT_ID('dbo.ledger', 'U') IS NULL
    CREATE TABLE dbo.ledger (id INT IDENTITY PRIMARY KEY, logged DATETIME2 NOT NULL, payload VARCHAR(4000) NOT NULL);
"@ | Out-Null
$logRow = Invoke-OnTrakSql -Query ('SELECT name FROM sys.master_files WHERE database_id = DB_ID(''' + $database + ''') AND type = 1')
$logName = '' + $logRow[0].name
Invoke-OnTrakSql -Query ('DBCC SHRINKFILE (' + $logName + ', 4)') | Out-Null
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' MODIFY FILE (NAME = ' + $logName + ', MAXSIZE = 4MB, FILEGROWTH = 0)') | Out-Null
# Fill the log until the lid stops it: 'saving records fails' is the ticket.
$full = $false
for ($round = 0; $round -lt 40 -and -not $full; $round++) {
    try {
        Invoke-OnTrakSql -Database $database -Query "INSERT INTO dbo.ledger (logged, payload) SELECT SYSDATETIME(), REPLICATE('x', 3800) FROM (SELECT TOP (400) 1 AS n FROM sys.all_columns) AS t" | Out-Null
        Invoke-OnTrakSql -Database $database -Query 'CHECKPOINT' | Out-Null
    } catch {
        $full = $true
    }
}""",
    assert_ps="""Require-OnTrak 'the fault is observable: saving records fails' {
    $saved = $true
    try {
        Invoke-OnTrakSql -Database 'TrainingDB' -Query "INSERT INTO dbo.ledger (logged, payload) VALUES (SYSDATETIME(), 'probe')" | Out-Null
    } catch { $saved = $false }
    -not $saved
}""",
    check_ps="""$database = 'TrainingDB'
# The probe runs a CHECKPOINT first: fairness to the simple-recovery fix (whose
# first save would race an auto-checkpoint) and, in full recovery, a free
# demonstration that the log stays full.
$saved = $false
$saveDetail = ''
try {
    Invoke-OnTrakSql -Database $database -Query 'CHECKPOINT' | Out-Null
    Invoke-OnTrakSql -Database $database -Query "INSERT INTO dbo.ledger (logged, payload) VALUES (SYSDATETIME(), 'probe')" | Out-Null
    $saved = $true
    $saveDetail = 'a record saved'
} catch {
    $saveDetail = 'the write fails: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'db-can-save' -Passed $saved -Detail $saveDetail
$growOk = $false
$growDetail = ''
try {
    $fileRow = Invoke-OnTrakSql -Query ('SELECT growth, max_size FROM sys.master_files WHERE database_id = DB_ID(''' + $database + ''') AND type = 1')
    $growth = [int] $fileRow[0].growth
    $maxSize = [int] $fileRow[0].max_size
    $growOk = ($growth -gt 0) -or ($maxSize -eq -1)
    $growDetail = ('autogrowth: ' + $growth + '; max size: ' + $maxSize)
} catch {
    $growDetail = ('the log settings could not be read: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'db-log-can-grow' -Passed $growOk -Detail $growDetail
$roomOk = $false
$roomDetail = ''
try {
    $space = Invoke-OnTrakSql -Database $database -Query 'SELECT used_log_space_in_bytes, total_log_size_in_bytes FROM sys.dm_db_log_space_usage'
    $usedPct = 0
    if (([double] $space[0].total_log_size_in_bytes) -gt 0) {
        $usedPct = [math]::Round(100 * ([double] $space[0].used_log_space_in_bytes) / ([double] $space[0].total_log_size_in_bytes), 1)
    }
    $roomOk = $usedPct -lt 90
    $roomDetail = ('the log is ' + $usedPct + '% full')
} catch {
    $roomDetail = ('log space could not be read: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'db-log-has-room' -Passed $roomOk -Detail $roomDetail""",
    difficulty=3,
    minutes=25,
    hints=[
        "'The log is full' is literal and the disk is not the resource: the log file's size cap is.",
        "In full recovery, committed transactions stay in the log until a log backup clears them — a checkpoint alone provably clears nothing here.",
        "Two halves: give the log room now (autogrowth, or a bigger cap) and get the standing volume of log out (a log backup, or the recovery model the estate uses) so this cannot repeat.",
    ],
    tags=["sql", "capacity"],
    notes="The check probes with CHECKPOINT first so the simple-recovery fix works the moment it is set.",
)


# --------------------------------------------------------------------------- #
# messaging and collaboration — Exchange and SharePoint
# --------------------------------------------------------------------------- #

primitive(
    id="mail-transport-stopped",
    label="Mail transport service stopped and disabled",
    category=Category.NETWORK.value,
    title="Mail is just sitting in the Outbox",
    briefing=(
        "Nothing has sent or arrived since this morning: messages sit in the "
        "Outbox and time out, and external senders say the server refuses them. "
        "The server pings, and port 25 answers."
    ),
    objectives=[
        Objective("mail-transport-running", "The mail transport service is running again", 3, critical=True),
        Objective("mail-smtp-accepts", "The server accepts an SMTP message end to end", 2, critical=True),
        Objective("mail-transport-automatic", "The transport service starts automatically again", 1),
    ],
    setup_ps="""$serviceName = 'MSExchangeTransport'
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
Write-OnTrakStep ('the hardening script left ' + $serviceName + ' stopped and disabled')""",
    assert_ps="""Require-OnTrak 'the transport service is stopped and disabled' {
    (Get-OnTrakServiceState -Name 'MSExchangeTransport') -ne 'Running'
}
Require-OnTrak 'the fault is observable: the server no longer takes mail' {
    -not (Test-OnTrakSmtpProbe)
}""",
    check_ps="""$serviceName = 'MSExchangeTransport'
$state = Get-OnTrakServiceState -Name $serviceName
Add-OnTrakCheck -Objective 'mail-transport-running' -Passed ($state -eq 'Running') -Detail ($serviceName + ' is ' + $state)
$accepted = $false
try { $accepted = Test-OnTrakSmtpProbe } catch { }
Add-OnTrakCheck -Objective 'mail-smtp-accepts' -Passed $accepted -Detail ('an SMTP transaction was accepted end to end: ' + $accepted)
$startType = 'Missing'
try { $startType = '' + (Get-Service -Name $serviceName -ErrorAction Stop).StartType } catch { }
Add-OnTrakCheck -Objective 'mail-transport-automatic' -Passed ($startType -eq 'Automatic') -Detail ('startup type is ' + $startType)""",
    difficulty=3,
    minutes=25,
    hints=[
        "A TCP connect to port 25 is the test this ticket passes before the fix: a banner is a listener, not mail flow.",
        "Mail in the Outbox is local submission failing; senders refused is delivery failing. Both are the same service, and it is not the one answering the port.",
    ],
    tags=["mail", "smtp", "exchange"],
    notes=(
        "Exchange-aware: the graded probe is Test-OnTrakSmtpProbe — a complete SMTP "
        "transaction — because a socket proves nothing about mail."
    ),
)

primitive(
    id="farm-timer-stopped",
    label="SharePoint farm services stopped and disabled",
    category=Category.SOFTWARE.value,
    title="The intranet stopped doing its scheduled work",
    briefing=(
        "The intranet serves every page, but nothing scheduled has happened since "
        "the weekend: alerts stopped, the dashboard is stale, and creating a site "
        "collection hangs."
    ),
    objectives=[
        Objective("farm-timer-running", "The farm's timer service is running", 3, critical=True),
        Objective("farm-admin-running", "The farm's administration service is running", 2),
        Objective("farm-services-automatic", "Both farm services start automatically again", 1),
    ],
    setup_ps="""$services = @('SPTimerV4', 'SPAdminV4')
foreach ($serviceName in $services) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
    Write-OnTrakStep ($serviceName + ' is stopped and disabled')
}""",
    assert_ps="""Require-OnTrak 'both farm services are down' {
    (@(@('SPTimerV4', 'SPAdminV4') | Where-Object { (Get-OnTrakServiceState $_) -eq 'Running' }).Count -eq 0)
}
Require-OnTrak 'the trap is in place: the farm still answers web requests' {
    Test-OnTrakTcpPort -ComputerName '127.0.0.1' -Port 8080
}""",
    check_ps="""$services = @('SPTimerV4', 'SPAdminV4')
$timerState = Get-OnTrakServiceState -Name 'SPTimerV4'
Add-OnTrakCheck -Objective 'farm-timer-running' -Passed ($timerState -eq 'Running') -Detail ('SPTimerV4 is ' + $timerState)
$adminState = Get-OnTrakServiceState -Name 'SPAdminV4'
Add-OnTrakCheck -Objective 'farm-admin-running' -Passed ($adminState -eq 'Running') -Detail ('SPAdminV4 is ' + $adminState)
$notAutomatic = @($services | Where-Object { ('' + (Get-Service -Name $_ -ErrorAction SilentlyContinue).StartType) -ne 'Automatic' })
Add-OnTrakCheck -Objective 'farm-services-automatic' -Passed ($notAutomatic.Count -eq 0) -Detail ('not automatic: ' + ($notAutomatic -join ', '))""",
    difficulty=2,
    minutes=25,
    hints=[
        "The sites serving pages is the web server, not the farm. The farm's own work is two Windows services underneath the product.",
        "One symptom is scheduled work not happening; the other is provisioning hanging. Two services, stopped together.",
    ],
    tags=["sharepoint", "farm", "services"],
    notes="SharePoint-aware: the trap assert is the Central Admin port answering while the farm does nothing.",
)


# --------------------------------------------------------------------------- #
# lookup helpers
# --------------------------------------------------------------------------- #


def get(primitive_id: str) -> FaultPrimitive:
    if primitive_id not in PRIMITIVES:
        raise KeyError(
            f"unknown fault primitive {primitive_id!r}; known: {', '.join(sorted(PRIMITIVES))}"
        )
    return PRIMITIVES[primitive_id]


def list_all() -> list[FaultPrimitive]:
    order = {c.value: index for index, c in enumerate(Category)}
    return sorted(PRIMITIVES.values(), key=lambda p: (order.get(p.category, 99), p.id))


def by_category() -> dict[str, list[FaultPrimitive]]:
    grouped: dict[str, list[FaultPrimitive]] = {}
    for item in list_all():
        grouped.setdefault(item.category, []).append(item)
    return grouped


def ids() -> list[str]:
    return [p.id for p in list_all()]
