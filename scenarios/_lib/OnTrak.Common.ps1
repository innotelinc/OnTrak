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

# Captured while this file is being dot-sourced (the only moment $PSScriptRoot is
# reliably *this* directory), because the caller's own $PSScriptRoot is the
# scenario folder. The marker file therefore lands in the guest's work directory,
# next to lib/ and scenarios/.
$script:OnTrakLibDir = $PSScriptRoot
$script:OnTrakSetupOkMarker = 'ONTRAK-SETUP-OK'
$script:OnTrakSetupOkPath = Join-Path (Split-Path $script:OnTrakLibDir -Parent) 'setup-ok.txt'

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
    .DESCRIPTION
        The confirmation is written twice on purpose: to stdout, where the template
        build reads it, and to a file beside this library. A scenario is allowed to
        break the transport it is being injected over -- `net-static-ip-conflict`
        re-addresses the adapter, which kills the very WinRM session running it and
        leaves the build with nothing but a read timeout -- so the file is what the
        build falls back to after finding the guest at its new address.
    #>
    [CmdletBinding()]
    param([string] $Note = '')
    if ($Note) { Write-Output ("setup note: " + $Note) }
    Write-Output 'ONTRAK-SETUP-OK'
    try {
        New-OnTrakFile -Path $script:OnTrakSetupOkPath -Content ('ONTRAK-SETUP-OK' + "`n" + $Note)
    } catch { }
}

function Require-OnTrak {
    <#
    .SYNOPSIS
        Assert something that has to be true for this fault to be worth snapshotting.
    .DESCRIPTION
        The PowerShell twin of the shell library's `ontrak_require`, and the reason
        both libraries have one: fault injection that quietly does nothing is worse
        than a build that fails. A student handed a ticket with no fault behind it
        hunts for something that is not there, and the grader passes them for it.

        So setup.ps1 asserts its own fault. When the assertion does not hold this
        exits *without* writing the success marker, and the template build refuses to
        snapshot a scenario whose setup did not confirm -- so the outcome is a failed
        build carrying the reason, not a broken ticket in somebody's lab.

        Assert on what the fault *does*, never on the mechanism that produced it: an
        image where a step was already in the desired state still has a working
        fault, and failing there would be a lie in the other direction.
    .PARAMETER What
        What should be true, phrased as the fault it proves.
    .PARAMETER Condition
        Script block that evaluates to $true when the fault is observable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)][string] $What,
        [Parameter(Mandatory = $true, Position = 1)][scriptblock] $Condition
    )
    $passed = $false
    try { $passed = [bool](& $Condition) } catch { $passed = $false }
    if ($passed) { return }
    Write-Output ('[ontrak] injection failed: ' + $What)
    Write-Output '[ontrak] the fault was NOT applied; not reporting setup success'
    exit 1
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
        Read the student's write-up, two ways.

        -Field requires a "Field: value" line whose value is at least -MinLength
        characters, so "asked the user to reboot" cannot earn points. -Pattern
        requires the report to mention a regular expression somewhere, which is
        how the triage scenarios check that it names the indicators that actually
        matter (the spoofed domain, the SPF failure, the action taken).

        Both are parameter sets on one function on purpose: a report objective is
        one kind of thing, and a second near-identical helper is how the two
        definitions drift apart.
    #>
    [CmdletBinding(DefaultParameterSetName = 'Field')]
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true, ParameterSetName = 'Field')][string] $Field,
        [Parameter(Mandatory = $true, ParameterSetName = 'Pattern')][string] $Pattern,
        [int] $MinLength = 15
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
    if (-not $text) { return $false }
    if ($PSCmdlet.ParameterSetName -eq 'Pattern') {
        return [bool]([regex]::IsMatch($text, $Pattern))
    }
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
        Real (non-phantom) plug-and-play devices matching a friendly name or
        a device class. Phantom devices are leftovers from the image build and
        must be ignored.
    #>
    [CmdletBinding()]
    param([string] $FriendlyName = '', [string] $Class = '')
    return @(Get-PnpDevice -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Problem -ne 'CM_PROB_PHANTOM') -and
            ((-not $FriendlyName) -or ($_.FriendlyName -like ('*' + $FriendlyName + '*'))) -and
            ((-not $Class) -or (('' + $_.Class) -eq $Class))
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

# ---------------------------------------------------------------- processes --
function Start-OnTrakProcess {
    <#
    .SYNOPSIS
        Launch a process from a full command line, without waiting for it.
    .DESCRIPTION
        Setup scripts register persistence and move on: the launched thing is a
        GUI payload or a logon task meant to outlive the script, so blocking on
        it would hang the template build. Win32_Process.Create takes the command
        line exactly as written — quoting and all — and returns as soon as the
        process exists. A process that does not start is an error: a fault that
        silently does not land must fail the build, not reach a student.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string] $CommandLine)
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine } -ErrorAction Stop
    if ($result.ReturnValue -ne 0) {
        throw ('the process did not start (Win32_Process.Create returned ' + $result.ReturnValue + ')')
    }
    return [int] $result.ProcessId
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

# --------------------------------------------------------------- database ---
function Invoke-OnTrakSql {
    <#
    .SYNOPSIS
        Run a T-SQL batch against the SQL Server instance and return the first
        result set's rows. Throws when the batch cannot run.
    .DESCRIPTION
        The database scenarios have to speak SQL and there is no sqlcmd to help
        them: the product build installs the SQLENGINE feature and none of the
        client tools. ADO.NET ships with Windows, connects as the signed-in
        account (which the product build made a SQL sysadmin), and surfaces SQL
        errors as exceptions -- which is the shape both callers want, since "the
        write failed" is a fault to assert on and "the query could not run at
        all" is a different thing to report honestly.

        Pass -Server 'tcp:<host>,1433' to force the TCP protocol: a default local
        connection rides shared memory and succeeds even when nothing answers the
        network, which is the whole point of `net-db-protocols`.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $Query,
        [string] $Database = 'master',
        [string] $Server = 'localhost',
        [int] $TimeoutSeconds = 30
    )
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = $Server
    $builder['Initial Catalog'] = $Database
    $builder['Integrated Security'] = $true
    $builder['Connect Timeout'] = $TimeoutSeconds
    $connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
    $table = New-Object System.Data.DataTable
    try {
        $connection.Open()
        $command = $connection.CreateCommand()
        $command.CommandText = $Query
        $command.CommandTimeout = $TimeoutSeconds
        $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $command
        [void] $adapter.Fill($table)
    } finally {
        $connection.Close()
    }
    return @($table.Rows | ForEach-Object { $_ })
}

# -------------------------------------------------------------------- mail --
function Test-OnTrakSmtpProbe {
    <#
    .SYNOPSIS
        Submit a complete SMTP transaction and report whether the server took the
        message.
    .DESCRIPTION
        A TCP connect to port 25 proves a listener exists and nothing about mail
        flow: Exchange's frontend answers the port while the transport service
        behind it is dead, which is exactly the trap in `net-mail-queue`. This
        walks the SMTP conversation (banner, EHLO, MAIL FROM, RCPT TO, DATA) and
        only reports true when the server accepts responsibility for a message --
        which is what a sender actually experiences.
    #>
    [CmdletBinding()]
    param(
        [string] $ComputerName = '127.0.0.1',
        [int] $Port = 25,
        [string] $Sender = 'probe@ontrak.lab',
        [string] $Recipient = 'postmaster@ontrak.lab',
        [int] $TimeoutSeconds = 15
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect($ComputerName, $Port)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutSeconds * 1000
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
        $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
        $writer.NewLine = "`r`n"
        $writer.AutoFlush = $true

        function Read-OnTrakSmtpCode {
            # SMTP replies are "NNN-text" continuation lines until "NNN text".
            $line = $reader.ReadLine()
            $code = 0
            while ($null -ne $line) {
                if ($line.Length -ge 3) { $code = [int] $line.Substring(0, 3) }
                if ($line.Length -lt 4 -or $line[3] -ne '-') { break }
                $line = $reader.ReadLine()
            }
            return $code
        }

        if ((Read-OnTrakSmtpCode) -ne 220) { return $false }
        $writer.WriteLine('EHLO ontrak.lab')
        if ((Read-OnTrakSmtpCode) -ne 250) { return $false }
        $writer.WriteLine(('MAIL FROM:<' + $Sender + '>'))
        if ((Read-OnTrakSmtpCode) -ne 250) { return $false }
        $writer.WriteLine(('RCPT TO:<' + $Recipient + '>'))
        $rcpt = Read-OnTrakSmtpCode
        if ($rcpt -ne 250 -and $rcpt -ne 251) { return $false }
        $writer.WriteLine('DATA')
        if ((Read-OnTrakSmtpCode) -ne 354) { return $false }
        $writer.WriteLine('Subject: OnTrak SMTP probe')
        $writer.WriteLine('')
        $writer.WriteLine('Automated mail-flow probe.')
        $writer.WriteLine('.')
        if ((Read-OnTrakSmtpCode) -ne 250) { return $false }
        $writer.WriteLine('QUIT')
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

# -------------------------------------------------------------- automation --
function Test-OnTrakComLaunch {
    <#
    .SYNOPSIS
        Prove a COM automation application really starts: create its automation
        object in a child process, quit it, and report whether that worked.
    .DESCRIPTION
        "The process exists" is no proof an application opened: an error dialog
        is a process too, and with Office's launcher broken WINWORD.EXE still
        spawns and shows one. Creating and quitting the automation object is
        what every launch does underneath, and it only succeeds when the
        application genuinely comes up.

        The probe runs in its own powershell.exe and is bounded twice over: a
        first-run dialog or a hung activation is killed with its process rather
        than hanging the grade (WaitForExit with a timeout, then Kill), and the
        calling script survives whatever the application does to its host.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $ProgId,
        [int] $TimeoutSeconds = 60
    )
    $inner = ('try { $app = New-Object -ComObject ' + $ProgId + '; $app.Quit(); exit 0 } catch { exit 1 }')
    $proc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $inner) `
        -PassThru -WindowStyle Hidden -ErrorAction Stop
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill() } catch { }
        return $false
    }
    return ($proc.ExitCode -eq 0)
}
