#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Parse every guest PowerShell script, and audit it for the comma/plus trap.

.DESCRIPTION
    Both halves exist because the scripts in this repository run on a Windows guest
    that no one here has: CI has never booted one, so the only cheap check is on the
    text. That check has two levels, and they catch different mistakes.

    **Parsing** catches a script that will not load at all. It says nothing about a
    script that loads and then hands a program the wrong arguments.

    **The audit** catches exactly that: PowerShell's comma binds *tighter* than `+`
    (https://github.com/PowerShell/PowerShell/issues/8495), so inside an array
    literal a concatenation next to a comma is not the element it looks like. Both
    directions were live in this tree and both are silent at parse time:

        @('/PrepareAD', '/OrganizationName:"' + $org + '"')
            ...is not two arguments. It is @('/PrepareAD', '/OrganizationName:"')
            plus $org plus '"' — four arguments.

        @('/ConfigurationFile=' + $ini, '/IACCEPTEULA')
            ...is not two either. It is one: string + array flattens to a single
            space-joined argument, so setup receives an empty path and dies.

    A *newline* sorts the elements safely; only the comma does not. Parentheses
    always fix it, and are the thing to reach for:

        @('/PrepareAD', ('/OrganizationName:"' + $org + '"'))

    Exit code is 0 when every script parses and no script trips the audit, 1
    otherwise — so this is safe to use as a gate in CI, and in the container
    (`make ps-check`).

.PARAMETER Root
    The checkout to read. Defaults to this script's parent directory.

.PARAMETER Path
    The directories under Root to search, recursively. Defaults to the two places
    guest scripts live: scenarios/ and infra/.

.PARAMETER Annotations
    Emit GitHub's `::error file=…::…` lines so failures land on the diff in CI.
    Off by default: the syntax is noise in a terminal.

.EXAMPLE
    pwsh -File scripts/check-powershell.ps1

.EXAMPLE
    pwsh -File scripts/check-powershell.ps1 -Annotations   # what CI runs
#>
[CmdletBinding()]
param(
    [string] $Root = (Split-Path -Parent $PSScriptRoot),
    [string[]] $Path = @('scenarios', 'infra'),
    [switch] $Annotations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Plus = [System.Management.Automation.Language.TokenKind]::Plus
$Array = [System.Management.Automation.Language.ArrayLiteralAst]
$Binary = [System.Management.Automation.Language.BinaryExpressionAst]
$Paren = [System.Management.Automation.Language.ParenExpressionAst]

$failures = [System.Collections.Generic.List[string]]::new()
$offenders = [System.Collections.Generic.List[object]]::new()

function Report-Error {
    param([string] $File, [int] $Line, [string] $Message)
    $failures.Add("$File`:$Line`: $Message")
    if ($Annotations) { Write-Host "::error file=$File,line=$Line::$Message" }
    else { Write-Host "error: $File`:$Line`: $Message" }
}

# ── the audit ────────────────────────────────────────────────────────────────
# Two shapes, both found by asking the parser rather than by reading the code.
# `Parent` is what distinguishes them from the safe spellings: a `+` wrapped in
# parentheses is an expression the author asked for, and `@()` elements separated
# by newlines carry no comma to mis-bind against.
function Find-CommaPlusTrap {
    param([System.Management.Automation.Language.Ast] $Ast, [string] $File)

    $arrays = $Ast.FindAll({ param($node) $node -is $Array }, $true)
    foreach ($array in $arrays) {
        # `@('a', 'b' + $x)` — the comma binds first, so this array is the left
        # operand of the `+` and the whole thing is array + scalar.
        $parent = $array.Parent
        if ($parent -is $Binary -and $parent.Operator -eq $Plus) {
            $offenders.Add([pscustomobject]@{
                File    = $File
                Line    = $array.Extent.StartLineNumber
                Text    = $parent.Extent.Text.Trim()
                Shape   = 'the comma binds first: this array is an operand of +'
            })
        }

        # `@('a' + $x, 'b')` — the comma is swallowed by the `+`, making the
        # element a concatenation of a string and an array.
        foreach ($element in $array.Elements) {
            if ($element -is $Binary -and $element.Operator -eq $Plus) {
                # A parenthesised element is the fix, not the fault.
                if ($element.Parent -is $Paren) { continue }
                $offenders.Add([pscustomobject]@{
                    File  = $File
                    Line  = $element.Extent.StartLineNumber
                    Text  = $element.Extent.Text.Trim()
                    Shape = 'the comma was swallowed by +: string + array flattens to one argument'
                })
            }
        }
    }
}

# ── walk the scripts ─────────────────────────────────────────────────────────
$files = @()
foreach ($dir in $Path) {
    $full = Join-Path $Root $dir
    if (-not (Test-Path $full)) { continue }
    $files += Get-ChildItem -Path $full -Recurse -Filter *.ps1 -File
}
$files = @($files | Sort-Object FullName)

Write-Host "pwsh $($PSVersionTable.PSVersion) — checking $($files.Count) script(s) under $($Path -join ', ')"

$parseFailures = 0
foreach ($file in $files) {
    $errors = $null
    $tree = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) {
        $parseFailures++
        foreach ($error in $errors) {
            Report-Error -File $file.FullName -Line $error.Extent.StartLineNumber -Message $error.Message
        }
        # No tree worth auditing when it does not parse.
        continue
    }
    # Relative paths read better in a report, and are what CI's annotations use.
    $relative = [System.IO.Path]::GetRelativePath($Root, $file.FullName)
    Find-CommaPlusTrap -Ast $tree -File $relative
}

foreach ($offender in $offenders) {
    $message = "$($offender.Shape) — parenthesise it: $($offender.Text)"
    Report-Error -File $offender.File -Line $offender.Line -Message $message
}

Write-Host "parsed: $($files.Count - $parseFailures)/$($files.Count)"
Write-Host "comma/plus trap: $($offenders.Count) finding(s)"

if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) problem(s) — see above"
    exit 1
}
Write-Host 'guest PowerShell: ok'
exit 0
