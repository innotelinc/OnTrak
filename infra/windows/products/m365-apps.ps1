# m365-apps.ps1 — Microsoft 365 Apps for enterprise, over the Office Deployment Tool.
#
# Layered onto win11-24h2 by `m365-apps-on-win11` (catalog/office.yaml). This is the
# one Office entry with a recipe rather than a weekend of clicking: Microsoft ships the
# Deployment Tool for exactly this, and the click-to-run install is a configuration
# file and one command.
#
# What the operator supplies (`media: {kind: archive}`) is the Deployment Tool download
# from their own tenant: `setup.exe` plus, if they want an offline build, the payload
# beside it. OnTrak never fetches it. The descriptor says where the archive was pushed;
# this unpacks it if it is still packed, writes the configuration, installs, and then
# checks the click-to-run registration Microsoft records per product.
#
# Not run against real media: no Office media ships here, and no Windows VM runs in
# this checkout. See docs/roadmap.md for the honest label.

. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin
$config = Get-ProductConfig

$folder = if ($config.media_folder) { $config.media_folder } else { 'C:\ProgramData\OnTrak\media\m365-apps' }
if (-not (Test-Path (Join-Path $folder 'setup.exe'))) {
    if (-not ($config.media_archive -and (Test-Path $config.media_archive))) {
        Fail ('neither ' + (Join-Path $folder 'setup.exe') + ' nor the archive ' +
            $config.media_archive + ' is there: the builder pushes the Deployment Tool in')
    }
    Step ('unpacking ' + $config.media_archive + ' into ' + $folder)
    Expand-Archive -Path $config.media_archive -DestinationPath $folder -Force
}
$setup = Join-Path $folder 'setup.exe'
if (-not (Test-Path $setup)) {
    Fail ('no setup.exe under ' + $folder + ': the Deployment Tool download belongs there, ' +
        'and the descriptor says where the builder put it')
}
Step ('Deployment Tool: ' + $folder)

# The channel is the descriptor's business, because a scenario about "an update changed
# how this behaves" only makes sense if the build knew which channel it installed.
$channel = if ($config.channel) { $config.channel } else { 'Current' }
$productId = if ($config.product_id) { $config.product_id } else { 'O365ProPlusRetail' }
$configXml = Join-Path $folder 'ontrak-configuration.xml'
@"
<Configuration>
  <Add OfficeClientEdition="64" Channel="$channel" SourcePath="$folder">
    <Product ID="$productId">
      <Language ID="en-us" />
    </Product>
  </Add>
  <Display Level="None" AcceptEULA="TRUE" />
  <Property Name="AUTOACTIVATE" Value="1" />
  <Property Name="FORCEAPPSHUTDOWN" Value="TRUE" />
  <Logging Level="Standard" Path="C:\ProgramData\OnTrak\logs" />
</Configuration>
"@ | Set-Content -Path $configXml -Encoding UTF8
Step ('wrote ' + $configXml + ' (channel ' + $channel + ', product ' + $productId + ')')

# The Deployment Tool wants its own directory as the working directory: `SourcePath`
# above is absolute, but a relative payload lookup starts from wherever it was invoked.
Push-Location $folder
try {
    Invoke-InstallStep -FilePath $setup -What 'click-to-run install' `
        -Arguments @('/configure', $configXml) -TimeoutSeconds 3600 | Out-Null
} finally {
    Pop-Location
}

# -- verification --------------------------------------------------------------
# Office records the click-to-run installation here, one value per product, and a
# machine whose Office is installed but unregistered is exactly the ticket this
# workload exists for — so the build checks the registration rather than the shortcut.
$clickToRun = 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'
if (-not (Test-Path $clickToRun)) {
    Fail 'click-to-run left no configuration under HKLM:\SOFTWARE\Microsoft\Office\ClickToRun'
}
$properties = Get-ItemProperty -Path $clickToRun
$installed = [string] $properties.ProductReleaseIds
if (-not $installed) {
    Fail 'Office is registered and names no product: the install did not complete'
}
Step ('click-to-run reports: ' + $installed + ' (version ' + [string] $properties.VersionToReport + ')')

$binaries = Join-Path $env:ProgramFiles 'Microsoft Office\root\Office16'
if (-not (Test-Path $binaries)) {
    Fail ('no Office binaries under ' + $binaries)
}
Step ('binaries in place: ' + $binaries)

Write-Output $productOkMarker
Write-Output ('m365-apps ' + $installed + ' installed from the ' + $channel + ' channel')
