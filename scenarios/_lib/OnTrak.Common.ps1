# OnTrak.Common.ps1
#
# Shared helpers for OnTrak scenario scripts. Dot-source it at the top of every
# setup.ps1 / check.ps1:
#
#     . "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"
#
# Contract:
#   * check.ps1 calls Add-OnTrakCheck once per objective declared in scenario.yaml,
#     then Write-OnTrakReport exactly once.
#   * setup.ps1 ends with Write-OnTrakSetupOk. The template build refuses to
#     snapshot a scenario whose setup did not confirm success, so a half-applied
#     fault can never reach a student.
#
# Everything here is deliberately Windows PowerShell 5.1 compatible (no ternary
# operator, no null-coalescing) and uses CIM cmdlets rather than the deprecated
# WMI ones.

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

# Must match ontrak/scenarios.py
$script:OnTrakBegin = '###ONTRAK-JSON-BEGIN###'
$script:OnTrakEnd   = '###ONTRAK-JSON-END###'
$script:OnTrakChecks = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- reporting --
function Add-OnTrakCheck {
    <#
    .SYNOPSIS
        Record the outcome of one objective.
    .PARAMETER Objective
        Objective id exactly as written in scenario.yaml.
    .PARAMETER Passed
        $true when the student's machine now satisfies the objective.
    .PARAMETER Detail
        Short evidence string shown to the student (what you observed, not how
        to fix it).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Objective,
        [Parameter(Mandatory = $true)][bool] $Passed,
        [string] $Detail = ''
    )
    $null = $script:OnTrakChecks.Add([ordered]@{
        objective = $Objective
        passed    = [bool]$Passed
        detail    = [string]$Detail
    })
}

function Write-OnTrakReport {
    <#
    .SYNOPSIS
        Emit the grading payload between markers and stop accumulating.
    #>
    [CmdletBinding()]
    param()
    $payload = [ordered]@{ checks = $script:OnTrakChecks } | ConvertTo-Json -Depth 6 -Compress
    Write-Output $script:OnTrakBegin
    Write-Output $payload
    Write-Output $script:OnTrakEnd
}

function Write-OnTrakSetupOk {
    <#
    .SYNOPSIS
        Confirm that fault injection finished. Required at the end of setup.ps1.
    #>
    [CmdletBinding()]
    param([string] $Note = '')
    if ($Note) { Write-Output ("setup note: " + $Note) }
    Write-Output 'ONTRAK-SETUP-OK'
}

function Write-OnTrakStep {
    [CmdletBinding()]
    param([string] $Message)
    Write-Output ("[ontrak] " + $Message)
}

# ------------------------------------------------------------------ network --
function Get-OnTrakPrimaryAdapter {
    <#
    .SYNOPSIS
        The adapter the student's connectivity actually depends on.
    #>
    [CmdletBinding()]
    param()
    $candidates = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway })
    if ($candidates.Count -eq 0) {
        $candidates = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.NetAdapter.InterfaceDescription -notlike '*Loopback*' })
    }
    if ($candidates.Count -eq 0) { return $null }
    return $candidates[0]
}

function Get-OnTrakPrimaryAdapterName {
    [CmdletBinding()]
    param()
    $adapter = Get-OnTrakPrimaryAdapter
    if ($adapter) { return $adapter.InterfaceAlias }
    return $null
}

function Get-OnTrakDnsServerAddress {
    [CmdletBinding()]
    param([string] $InterfaceAlias)
    if (-not $InterfaceAlias) { $InterfaceAlias = Get-OnTrakPrimaryAdapterName }
    if (-not $InterfaceAlias) { return @() }
    $servers = @(Get-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue)
    if ($servers.Count -eq 0) { return @() }
    return @($servers[0].ServerAddresses | Where-Object { $_ })
}

function Test-OnTrakDhcpEnabled {
    [CmdletBinding()]
    param([string] $InterfaceAlias)
    if (-not $InterfaceAlias) { $InterfaceAlias = Get-OnTrakPrimaryAdapterName }
    try {
        $config = Get-NetIPInterface -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction Stop
        return ($config.Dhcp -eq 'Enabled')
    } catch { return $false }
}

function Test-OnTrakDefaultGatewayReachable {
    <#
    .SYNOPSIS
        Ping the default gateway. Uses the ICMP echo reply, so a host firewall is
        not mistaken for a broken route.
    #>
    [CmdletBinding()]
    param([int] $TimeoutMs = 4000)
    $adapter = Get-OnTrakPrimaryAdapter
    if (-not $adapter -or -not $adapter.IPv4DefaultGateway) { return $false }
    $gateway = $adapter.IPv4DefaultGateway.NextHop
    if (-not $gateway) { return $false }
    try {
        $ping = New-Object System.Net.NetworkInformation.Ping
        $reply = $ping.Send($gateway, $TimeoutMs)
        return ($reply.Status -eq 'Success')
    } catch { return $false }
}

function Test-OnTrakDnsName {
    <#
    .SYNOPSIS
        Resolve A records via DNS itself (-DnsOnly), so a hosts-file entry cannot
        make a broken resolver look healthy.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [string] $Server,
        [int] $TimeoutSeconds = 5
    )
    try {
        $args = @{ Name = $Name; Type = 'A'; DnsOnly = $true; ErrorAction = 'Stop' }
        if ($Server) { $args['Server'] = $Server }
        $records = @(Resolve-DnsName @args)
        return [bool](@($records | Where-Object { $_.IPAddress }).Count -gt 0)
    } catch { return $false }
}

function Test-OnTrakTcpPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $ComputerName,
        [Parameter(Mandatory = $true)][int] $Port,
        [int] $TimeoutMs = 3000
    )
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync($ComputerName, $Port)
        if ($task.Wait($TimeoutMs)) {
            $connected = $client.Connected
            $client.Close()
            return $connected
        }
        $client.Close()
        return $false
    } catch { return $false }
}

function Reset-OnTrakDnsCache {
    [CmdletBinding()]
    param()
    try { Clear-DnsClientCache -ErrorAction SilentlyContinue } catch { }
}

function Get-OnTrakHostsEntry {
    <#
    .SYNOPSIS
        Hosts-file lines matching a name (used to detect redirects).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Hostname)
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if (-not (Test-Path $path)) { return @() }
    return @(Get-Content -Path $path -ErrorAction SilentlyContinue |
        Where-Object { $_ -notmatch '^\s*#' -and $_ -match [regex]::Escape($Hostname) })
}

function Remove-OnTrakHostsEntry {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Hostname)
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $lines = @(Get-Content -Path $path -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^\s*#' -or $_ -notmatch [regex]::Escape($Hostname) })
    Set-Content -Path $path -Value $lines -Encoding ASCII -ErrorAction SilentlyContinue
}

# -------------------------------------------------------------------- files --
function Get-OnTrakFreeDiskGB {
    [CmdletBinding()]
    param([string] $DriveLetter = 'C')
    $drive = $DriveLetter.TrimEnd(':') + ':'
    try {
        $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $drive + "'") -ErrorAction Stop
        if (-not $disk) { return 0 }
        return [math]::Round(($disk.FreeSpace / 1GB), 2)
    } catch { return 0 }
}

function Test-OnTrakFileExists {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Test-Path -LiteralPath $Path -PathType Leaf)
}

function New-OnTrakFile {
    <#
    .SYNOPSIS
        Write a file, creating parent directories. Used by setup.ps1.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [string] $Content = '',
        [switch] $Append
    )
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if ($Append) {
        Add-Content -Path $Path -Value $Content -Encoding UTF8
    } else {
        Set-Content -Path $Path -Value $Content -Encoding UTF8
    }
}

function Test-OnTrakReportField {
    <#
    .SYNOPSIS
        Check that the student's incident report contains a "Field: value" line
        with a non-trivial value. Used by write-up objectives so "asked the user
        to reboot" cannot earn points.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Field,
        [int] $MinLength = 15
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
    if (-not $text) { return $false }
    $match = [regex]::Match($text, '(?im)^\s*' + [regex]::Escape($Field) + '\s*:\s*(?<value>.+)$')
    if (-not $match.Success) { return $false }
    return ($match.Groups['value'].Value.Trim().Length -ge $MinLength)
}

# ----------------------------------------------------------------- services --
function Get-OnTrakServiceState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    try {
        $service = Get-Service -Name $Name -ErrorAction Stop
        return $service.Status.ToString()
    } catch { return 'Missing' }
}

function Start-OnTrakServiceIfNeeded {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    try {
        $service = Get-Service -Name $Name -ErrorAction Stop
        $startType = (Get-CimInstance Win32_Service -Filter ("Name='" + $Name + "'") -ErrorAction SilentlyContinue).StartMode
        if ($startType -eq 'Disabled') {
            Set-Service -Name $Name -StartupType Automatic -ErrorAction SilentlyContinue
        }
        if ($service.Status -ne 'Running') {
            Start-Service -Name $Name -ErrorAction SilentlyContinue
        }
    } catch { }
}

# ------------------------------------------------------------------ devices --
function Get-OnTrakPnpDevice {
    <#
    .SYNOPSIS
        Real (non-phantom) plug-and-play devices matching a friendly name.
        Phantom devices are leftovers from the image build and must be ignored.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $FriendlyName)
    return @(Get-PnpDevice -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FriendlyName -like ('*' + $FriendlyName + '*') -and
            $_.Problem -ne 'CM_PROB_PHANTOM'
        })
}

function Enable-OnTrakPnpDevice {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $FriendlyName)
    $devices = Get-OnTrakPnpDevice -FriendlyName $FriendlyName
    foreach ($device in $devices) {
        Enable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    }
}

# -------------------------------------------------------------- persistence --
function Get-OnTrakRunKeyValue {
    <#
    .SYNOPSIS
        Read a persistence entry from the Run keys (HKLM + HKCU, both hives).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    )
    foreach ($path in $paths) {
        if (-not (Test-Path $path)) { continue }
        $value = (Get-ItemProperty -Path $path -Name $Name -ErrorAction SilentlyContinue).$Name
        if ($value) { return [string]$value }
    }
    return ''
}

function Set-OnTrakRunKeyValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Value,
        [string] $Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    )
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}

function Remove-OnTrakRunKeyValue {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    foreach ($path in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run')) {
        if (Test-Path $path) {
            Remove-ItemProperty -Path $path -Name $Name -ErrorAction SilentlyContinue
        }
    }
}

function Get-OnTrakScheduledTask {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    return @(Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}

function Remove-OnTrakScheduledTask {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
}

# -------------------------------------------------------------- local users --
function Test-OnTrakLocalAdmin {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    try {
        $members = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop)
        return [bool](@($members | Where-Object { $_.Name -match ('\\' + [regex]::Escape($Name) + '$') }).Count -gt 0)
    } catch { return $false }
}

# ------------------------------------------------------------------ malware --
function Test-OnTrakDefenderRealTime {
    <#
    .SYNOPSIS
        $true when Defender real-time protection is on.
    #>
    [CmdletBinding()]
    param()
    try {
        $status = Get-MpComputerStatus -ErrorAction Stop
        return [bool]$status.RealTimeProtectionEnabled
    } catch { return $false }
}

function Test-OnTrakProcessRunning {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    $procs = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
    return ($procs.Count -gt 0)
}

function Stop-OnTrakProcess {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $Name)
    Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- resources --
function Get-OnTrakCpuLoad {
    <#
    .SYNOPSIS
        Average total CPU load as a percentage across $Samples readings.
        Sampling beats a single read: a momentary spike would otherwise fail or
        pass a "machine is responsive again" objective by luck.
    #>
    [CmdletBinding()]
    param([int] $Samples = 5, [int] $IntervalMs = 1000)
    $readings = @()
    for ($i = 0; $i -lt $Samples; $i++) {
        $value = (Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue |
            Measure-Object -Property LoadPercentage -Average).Average
        if ($null -ne $value) { $readings += [double]$value }
        if ($i -lt ($Samples - 1)) { Start-Sleep -Milliseconds $IntervalMs }
    }
    if ($readings.Count -eq 0) { return -1 }
    return [math]::Round(($readings | Measure-Object -Average).Average, 1)
}

function Get-OnTrakTopProcess {
    <#
    .SYNOPSIS
        The process eating the most CPU seconds right now (name + pid).
    #>
    [CmdletBinding()]
    param()
    return Get-Process -ErrorAction SilentlyContinue |
        Sort-Object -Property CPU -Descending |
        Select-Object -First 3 -Property Name, Id, CPU
}

function Get-OnTrakUptimeMinutes {
    [CmdletBinding()]
    param()
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        return [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes, 1)
    } catch { return -1 }
}
