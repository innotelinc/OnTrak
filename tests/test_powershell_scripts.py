"""The repository's PowerShell, read as text rather than run.

CI runs `scripts/check-powershell.ps1`, which parses every `.ps1` here with
PowerShell itself and then audits the parse trees for the trap described below.
This file is that same check with no PowerShell involved — cheap enough to run
anywhere, and the reason the trap is checked twice rather than once. Most of these
scripts are
Windows ones: they inject faults in a Windows guest, or install Exchange, SQL
Server, SharePoint and Microsoft 365 Apps inside one, and no Windows VM or
licensed media runs in this checkout. So the mistakes worth pinning here are the
ones that parse cleanly and only surface on a lab host, forty minutes into an
install, with a setup log as the only witness.

The one that bit is a precedence trap, and it is PowerShell's rather than anyone's
typo: **the comma binds tighter than `+`** (PowerShell/PowerShell#8495). Every shape
below was evaluated against pwsh 7.4.6 rather than reasoned about, because the two
that look alike behave differently:

    # comma first: the pieces are appended to a two-element array — four arguments
    @('/PrepareAD', '/OrganizationName:"' + $org + '"')
    # => '/PrepareAD', '/OrganizationName:"', 'contoso', '"'

    # comma after: what follows the comma is folded in *first*, and string `+` array
    # flattens to one space-joined string — a single argument setup cannot parse
    @('/ConfigurationFile=' + $ini, '/IACCEPTSQLSERVERLICENSETERMS', '/QUIET')
    # => '/ConfigurationFile=C:\\cfg.ini /IACCEPTSQLSERVERLICENSETERMS /QUIET'

    # newline-separated is fine: a newline inside `@(...)` ends the element, so the
    # `+` keeps its own element and the list still has three
    @(
        '/ConfigurationFile=' + $ini
        '/IAcceptsSQLServerLicenseTerms'
    )
    # => '/ConfigurationFile=C:\\cfg.ini', '/IAcceptsSQLServerLicenseTerms'

So the comma is the whole hazard, and the fix is always the same: give the
concatenation its own parentheses, as the scenario scripts already do
(`scenarios/sw-app-crash/check.ps1` wraps its own concatenated path). `@(('a' + $x),
'b')` is two elements and `@('a', ('b' + $x))` is two as well.

Both comma shapes were live in the tree when this file was written — the "comma
after" one in `infra/windows/products/sql-server.ps1`, handing SQL Server setup a
single argument, and the "comma first" one in `exchange-server.ps1`. The blind spot
is what the file is shaped around: a check for one direction would have declared the
tree clean with the other still in it. The check is scoped to `@(...)` bodies on
purpose — a comma in a *method call* is an argument separator, not an array
operator, so `[regex]::Match($text, '^\\s*' + [regex]::Escape($Field) + '$')` in
`scenarios/_lib/OnTrak.Common.ps1` is correct code and a line-level pattern cannot
tell the two apart.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_ROOTS = (REPO_ROOT / "scenarios", REPO_ROOT / "infra")

_QUOTES = ("'", '"')
_OPENERS = "([{"
_CLOSERS = ")]}"


def _string_end(text: str, start: int) -> int:
    """Index just past the PowerShell string literal opening at ``start``.

    Doubled quotes are an escaped quote in both kinds of PowerShell string, and a
    backtick escapes the next character inside a double-quoted one, so a paren in
    the middle of either does not close the array literal it sits in.
    """
    quote = text[start]
    index = start + 1
    while index < len(text):
        if text[index] == quote:
            if text.startswith(quote * 2, index):
                index += 2
                continue
            if quote == '"' and text[index - 1] == "`":
                index += 1
                continue
            return index + 1
        index += 1
    return index


def _here_string_end(text: str, start: int) -> int:
    """Index just past the ``@'...'@`` / ``@"..."@`` starting at ``start``."""
    terminator = text[start + 1] + "@"
    index = text.find("\n", start)
    while index != -1:
        end = text.find("\n", index + 1)
        line = text[index + 1 : end if end != -1 else len(text)]
        if line.startswith(terminator):
            return end if end != -1 else len(text)
        index = end
    return len(text)


def _skip_comment(text: str, start: int) -> int:
    end = text.find("\n", start)
    return end if end != -1 else len(text)


def _array_literals(text: str) -> list[tuple[int, str]]:
    """``(line number, body)`` for every ``@(...)`` literal in ``text``.

    Nested literals are reported in their own right as well: walking straight past
    the outer one would hide a concatenation sitting in the inner one.
    """
    found: list[tuple[int, str]] = []
    index = 0
    while index < len(text) - 1:
        char = text[index]
        if char == "#":
            index = _skip_comment(text, index)
            continue
        if char == "@" and text[index + 1] in _QUOTES:
            index = _here_string_end(text, index)
            continue
        if char == "@" and text[index + 1] == "(":
            line = text.count("\n", 0, index) + 1
            depth = 1
            cursor = index + 2
            while cursor < len(text) and depth:
                inner = text[cursor]
                if inner in _QUOTES:
                    cursor = _string_end(text, cursor)
                    continue
                if inner == "#":
                    cursor = _skip_comment(text, cursor)
                    continue
                if inner == "(":
                    depth += 1
                elif inner == ")":
                    depth -= 1
                cursor += 1
            found.append((line, text[index + 2 : cursor - 1]))
        index += 1
    return found


def _elements(body: str) -> list[tuple[str, str | None]]:
    """``(element, separator that ended it)`` for the body's top-level elements.

    Both a comma and a newline separate elements here, which is the distinction that
    matters: only the comma one is a hazard.
    """
    elements: list[tuple[str, str | None]] = []
    depth = 0
    chunk_start = 0
    index = 0
    while index < len(body):
        char = body[index]
        if char in _QUOTES:
            index = _string_end(body, index)
            continue
        if char == "#":
            index = _skip_comment(body, index)
            continue
        if char == "@" and index + 1 < len(body) and body[index + 1] in _QUOTES:
            index = _here_string_end(body, index)
            continue
        if char in _OPENERS:
            depth += 1
        elif char in _CLOSERS:
            depth -= 1
        elif depth == 0 and char in ",\n":
            elements.append((body[chunk_start:index], char))
            chunk_start = index + 1
        index += 1
    elements.append((body[chunk_start:], None))
    return elements


def _is_wrapped(element: str) -> bool:
    """True when the element is one parenthesized expression from end to end."""
    stripped = element.strip()
    if not stripped.startswith("("):
        return False
    depth = 0
    index = 0
    while index < len(stripped):
        char = stripped[index]
        if char in _QUOTES:
            index = _string_end(stripped, index)
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return not stripped[index + 1 :].strip()
        index += 1
    return False


def _has_top_level_plus(element: str) -> bool:
    """True when the element concatenates at its own level, not inside a call."""
    depth = 0
    index = 0
    while index < len(element):
        char = element[index]
        if char in _QUOTES:
            index = _string_end(element, index)
            continue
        if char == "#":
            index = _skip_comment(element, index)
            continue
        if char in _OPENERS:
            depth += 1
        elif char in _CLOSERS:
            depth -= 1
        elif char == "+" and depth == 0:
            return True
        index += 1
    return False


def _concatenations_next_to_commas(text: str) -> list[str]:
    """One line per array element whose concatenation sits next to a comma.

    ``elements`` are comma-adjacent when the comma ended them or ended the element
    before them, which is the two directions of the same trap.
    """
    offenders: list[str] = []
    for line, body in _array_literals(text):
        elements = _elements(body)
        for position, (element, separator) in enumerate(elements):
            comma_adjacent = separator == "," or (
                position > 0 and elements[position - 1][1] == ","
            )
            if not comma_adjacent or _is_wrapped(element) or not _has_top_level_plus(element):
                continue
            offenders.append(f"array literal at line {line}: {element.strip()}")
    return offenders


def test_no_array_literal_concatenates_next_to_a_comma():
    """An array element built by `+` needs its own parentheses. Nothing in this
    checkout runs a Windows guest, so reading the scripts is the only place the
    mistake can be caught before licensed media and an hour of setup are spent on
    it — and setup takes the arguments it is handed without complaint either way."""
    files = []
    for root in SCRIPT_ROOTS:
        files.extend(sorted(root.rglob("*.ps1")))
    assert len(files) > 10, f"the scripts were not found under {SCRIPT_ROOTS}"

    offenders = [
        f"{path.relative_to(REPO_ROOT)}:{finding}"
        for path in files
        for finding in _concatenations_next_to_commas(path.read_text(encoding="utf-8"))
    ]
    assert not offenders, (
        "PowerShell's comma binds tighter than '+', so this concatenation is not an "
        "element of the list — wrap it in parentheses:\n  " + "\n  ".join(offenders)
    )


def test_unattended_installs_carry_the_switches_their_modes_require():
    """The switches Microsoft documents as *required* for the mode each setup runs in.

    Read against the vendors' own unattended-install documentation, and pinned here
    for the same reason as the trap above: each omission parses cleanly, runs for
    forty minutes, and fails on a lab host with nothing but a setup log. These are
    documented contracts rather than preferences — "required, when the /Q or /QS
    parameter is specified", "required, when /SECURITYMODE=SQL", and the exit code
    whose meaning decides between a reboot and a re-run.
    """
    products = REPO_ROOT / "infra" / "windows" / "products"

    sql = (products / "sql-server.ps1").read_text(encoding="utf-8")
    for accepted in ('IACCEPTSQLSERVERLICENSETERMS="True"', 'SUPPRESSPRIVACYSTATEMENTNOTICE="True"'):
        assert accepted in sql, (
            f"sql-server.ps1 runs setup quietly without {accepted} in its configuration "
            "file — Microsoft's parameter table marks the license terms and the privacy "
            "notice as required whenever /Q or /QS is in play"
        )
    assert "3010" in sql, (
        "sql-server.ps1 does not look at setup's exit code 3010 — the documented "
        "'restart required' code whose two meanings (installed-restart, and "
        "restart-first) decide between a reboot and a re-run"
    )

    sharepoint = (products / "sharepoint-server.ps1").read_text(encoding="utf-8")
    assert "/IAcceptTheLicenseTerms" in sharepoint, (
        "sharepoint-server.ps1 runs setup.exe /config without /IAcceptTheLicenseTerms, "
        "which the documented command-line mode requires"
    )

    exchange = (products / "exchange-server.ps1").read_text(encoding="utf-8")
    assert "/InstallWindowsComponents" in exchange, (
        "exchange-server.ps1 runs unattended setup without /InstallWindowsComponents — "
        "Microsoft's documented switch for the Windows roles and features Exchange "
        "needs on a plain Server base"
    )

    m365 = (products / "m365-apps.ps1").read_text(encoding="utf-8")
    assert '<Property Name="AUTOACTIVATE"' not in m365, (
        "m365-apps.ps1 sets AUTOACTIVATE, which the Deployment Tool's documentation "
        "says not to set for Microsoft 365 Apps — it activates automatically"
    )


def _sql_configuration_file(text: str) -> list[str]:
    """The ini lines ``sql-server.ps1``'s ``$options`` block writes.

    The two values built at run time from the descriptor (``SAPWD`` and
    ``SQLSYSADMINACCOUNTS``) come back with ``…`` in the value slot: which keys the
    file carries is the contract, and what the lab puts in them is the lab's to choose.
    """
    bodies = [body for _, body in _array_literals(text) if "'[OPTIONS]'" in body]
    assert len(bodies) == 1, "sql-server.ps1 no longer writes exactly one [OPTIONS] block"
    lines: list[str] = []
    for element, _ in _elements(bodies[0]):
        element = element.strip()
        if not element or element.startswith("#"):
            continue
        if element.startswith("'"):
            lines.append(element[1:-1].replace("''", "'"))
            continue
        # ('SAPWD="' + $config.sa_password + '"') and its sibling: the key is
        # written in the script and the value is the descriptor's.
        match = re.match(r"^\(\s*'([A-Z0-9]+)=", element)
        assert match, f"unexpected expression in the ini block: {element}"
        lines.append(match.group(1) + '="…"')
    return lines


def test_sql_server_configuration_file_is_the_quiet_install_microsoft_documents():
    """The ConfigurationFile.ini `sql-server.ps1` writes, rebuilt and read.

    A configuration file is a wall of `KEY="VALUE"` lines in which the required keys
    are not marked required: Microsoft's command-prompt reference is the only place
    that says which ones a quiet install cannot run without ("Required, when the /Q
    or /QS parameter is specified for unattended installations"), and a missing one
    is discovered at the end of a long silent setup. So the block that generates the
    file is reconstructed and checked against that contract — including the table's
    one implication (`/SAPWD` is required when `/SECURITYMODE=SQL`) and the
    cross-check that the instance the file installs is the one the script's own
    verification then goes looking for.
    """
    text = (REPO_ROOT / "infra" / "windows" / "products" / "sql-server.ps1").read_text(
        encoding="utf-8"
    )
    lines = _sql_configuration_file(text)
    assert lines[0] == "[OPTIONS]", "what the script writes is not a setup configuration file"
    options: dict[str, str] = {}
    for line in lines[1:]:
        key, _, value = line.partition("=")
        options[key] = value.strip('"')

    # The quiet mode, and the two acceptances it makes required.
    assert options.get("QUIET") == "True"
    assert options.get("IACCEPTSQLSERVERLICENSETERMS") == "True"
    assert options.get("SUPPRESSPRIVACYSTATEMENTNOTICE") == "True"

    # The install the catalog entry promises: the engine, under the name the
    # verification's `Get-Service` goes on to check, with the TCP the fault scenarios
    # need ("a SQL Server that only answers on shared memory is not something a
    # student can be given a network fault to fix").
    assert options.get("ACTION") == "Install"
    assert "SQLEngine" in options.get("FEATURES", "")
    instance = options.get("INSTANCENAME")
    assert instance == "MSSQLSERVER"
    assert "Get-Service -Name " + instance in text, (
        "the verification does not check the instance the configuration file installs"
    )
    assert options.get("TCPENABLED") == "1"
    assert "-LocalPort 1433" in text, "nothing proves the TCP the configuration file enables"

    # The table's implication, and the key that is required for every edition but
    # Express: a mixed-mode instance with no sa password, or an instance nobody can
    # administer, is a build that failed late and expensively.
    if options.get("SECURITYMODE") == "SQL":
        assert "SAPWD" in options, "/SAPWD is documented as required when /SECURITYMODE=SQL"
    assert "SQLSYSADMINACCOUNTS" in options

    # Virtual service accounts, whose passwords the documentation allows to be
    # omitted — and omitting them is the point while there is no directory to put a
    # service account in.
    assert options.get("SQLSVCACCOUNT") == "NT SERVICE\\MSSQLSERVER"
    assert options.get("AGTSVCACCOUNT") == "NT SERVICE\\SQLSERVERAGENT"
    assert "SQLSVCPASSWORD" not in options and "AGTSVCPASSWORD" not in options
