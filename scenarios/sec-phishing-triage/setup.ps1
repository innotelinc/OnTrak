# Fault: a phishing email has arrived, the user has already "fixed" the intranet by
# editing the hosts file, and the attachment is sitting in Downloads. Nothing has been
# executed — the exercise is triage, containment and documentation, not malware removal.
#
# Everything here is a placeholder. No real malware, no external network, no real
# credentials. The attachment is a text file with an executable's name.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$mailDir = Join-Path $env:ProgramData 'OnTrak\Mail'
$downloads = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Path $mailDir -Force | Out-Null
New-Item -ItemType Directory -Path $downloads -Force | Out-Null

# A lookalike sender domain: homoglyph-free but easy to misread at a glance.
$sender = 'billing@0ntrak-invoices.example'
$lookalike = 'http://portal.0ntrak-invoices.example/pay?id=8842'

$eml = @"
From: Accounts Receivable <$sender>
To: user@ontrak.lab
Subject: FINAL NOTICE - Invoice 8842 overdue 14 days
Date: Mon, 14 Sep 2026 04:12:07 +0000
Authentication-Results: spf=fail (sender IP is 203.0.113.44) smtp.mailfrom=0ntrak-invoices.example
Received-SPF: fail (domain of 0ntrak-invoices.example does not designate 203.0.113.44 as permitted sender)
X-Mailer: PHPMailer 5.2.7

Your invoice 8842 is overdue. Download and review the attached statement
within 24 hours to avoid suspension of service.

$lookalike

Kind regards,
Accounts Receivable
"@

$emlPath = Join-Path $mailDir 'invoice-8842.eml'
New-OnTrakFile -Path $emlPath -Content $eml
Write-OnTrakStep ("seeded phishing message at " + $emlPath)

# The "attachment": a placeholder with the name and extension a user would be tempted by.
$attachment = Join-Path $downloads 'Invoice_8842_Statement.doc.exe'
New-OnTrakFile -Path $attachment -Content 'Simulated attachment placeholder. Not executable.'
New-OnTrakFile -Path (Join-Path $mailDir 'user-note.txt') -Content ('I downloaded this but I did not open it. I also could not reach the intranet portal, so I added a line to the hosts file, which fixed it.')
Write-OnTrakStep ("dropped placeholder attachment at " + $attachment)

# The user's "fix" for the unreachable portal: a hosts entry pointing the intranet
# name at the lookalike host. That entry now overrides real DNS for this machine.
Set-Content -Path (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') -Value @(
    '# Copyright (c) 1993-2009 Microsoft Corp.',
    '#',
    '# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.',
    '',
    '203.0.113.44   portal.ontrak.lab'
) -Force
Write-OnTrakStep 'added a lookalike hosts entry for portal.ontrak.lab (user-supplied "fix")'

Write-OnTrakSetupOk -Note 'phishing-triage seeded; no payload executed'
