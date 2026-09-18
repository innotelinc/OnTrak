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
