# Grading reads the machine and the written report. A student who identifies the
# indicators but leaves the attachment runnable, or contains it but writes nothing,
# gets partial credit — which is what the objectives are for.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$mailDir = Join-Path $env:ProgramData 'OnTrak\Mail'
$downloads = Join-Path $env:USERPROFILE 'Downloads'
$attachment = Join-Path $downloads 'Invoice_8842_Statement.doc.exe'
$report = Join-Path $env:ProgramData 'OnTrak\phishing-report.txt'
$lookalike = '0ntrak-invoices.example'

# Objective: phish-indicators
# The report has to name the indicators that actually matter: the spoofed sender
# domain and the failed SPF result are the evidence; "an email looked odd" is not.
$indicators = Test-OnTrakReportField -Path $report -Pattern $lookalike
$spf = Test-OnTrakReportField -Path $report -Pattern 'spf|SPF'
Add-OnTrakCheck -Objective 'phish-indicators' `
    -Passed ($indicators -and $spf) `
    -Detail ("report names the lookalike domain: " + $indicators + "; mentions the SPF failure: " + $spf)

# Objective: attachment-isolated
# Anywhere except the user's Downloads folder counts, as long as it is not runnable
# from where a user would click it.
$stillDownloadable = Test-OnTrakFileExists -Path $attachment
$quarantine = Join-Path $env:ProgramData 'Quarantine'
$quarantined = (Test-Path $quarantine) -and (@(Get-ChildItem -Path $quarantine -Filter 'Invoice_8842*' -ErrorAction SilentlyContinue).Count -gt 0)
$deleted = -not $stillDownloadable
Add-OnTrakCheck -Objective 'attachment-isolated' `
    -Passed (-not $stillDownloadable) `
    -Detail ("still in Downloads: " + $stillDownloadable + "; quarantined copy: " + $quarantined + "; removed: " + $deleted)

# Objective: hosts-restored
# The user's entry must be gone. Extra vendor comments are harmless; a redirect to
# the lookalike host is not.
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$entry = Get-OnTrakHostsEntry -HostName 'portal.ontrak.lab'
$bogus = @(Get-Content -Path $hostsPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '203\.0\.113\.44' })
Add-OnTrakCheck -Objective 'hosts-restored' `
    -Passed ((-not $entry) -and ($bogus.Count -eq 0)) `
    -Detail ("hosts entry for portal.ontrak.lab: '" + $entry + "'; lookalike lines remaining: " + $bogus.Count)

# Objective: phish-reported
# A triage that is not written down cannot be handed over: sender, URL and the action
# taken must all be present.
$sender = Test-OnTrakReportField -Path $report -Pattern 'billing@|invoices\.example'
$url = Test-OnTrakReportField -Path $report -Pattern 'portal\.0ntrak-invoices\.example'
$action = Test-OnTrakReportField -Path $report -Pattern 'quarantine|isolat|removed|deleted|blocked'
Add-OnTrakCheck -Objective 'phish-reported' `
    -Passed ($sender -and $url -and $action) `
    -Detail ("sender recorded: " + $sender + "; URL recorded: " + $url + "; action recorded: " + $action)

Write-OnTrakReport
