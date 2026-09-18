#!/usr/bin/env python3
"""Unit tests for secret-scan.py — the literal-credential scanner.

The scanner exists because a hardcoded secret-manager admin password once shipped
in this public repository, and it fails closed: a finding blocks the commit. That
makes both directions worth pinning down:

* it must still catch a literal credential — an under-firing scanner is the
  failure it was written for;
* it must not flag source code that merely *mentions* a credential-shaped name,
  because a scanner people learn to ignore is the same as no scanner. The case
  that prompted these tests: ``line.startswith("VAULT_TOKEN_FILE=")`` was reported
  as a literal secret, because the rule is a regex over source text and read a
  name out of the string literal, then took that literal's closing quote as the
  opening quote of a value.

The module under test lives in a file with a hyphen in its name, so it is loaded
by path.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCANNER = Path(__file__).resolve().parents[1] / "secret-scan.py"


def _load():
    spec = importlib.util.spec_from_file_location("secret_scan", SCANNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


scan = _load()

# Fixtures the scanner *must* catch are assembled from pieces rather than written
# out. This file is committed, and the pre-commit hook runs this very scanner over
# added lines — a provider key or a PEM header sitting here as a literal would
# block the commit that adds its own test. Joined at run time they are the real
# shapes again; split across a concatenation they match nothing.
PROVIDER_KEY_LINE = 'key = "' + "sk-" + "abcdefghijklmnop1234" + '"'
PRIVATE_KEY_LINE = "-" * 5 + "BEGIN OPENSSH PRIVATE KEY" + "-" * 5


def findings(line: str, *, label: str = "src/thing.py") -> list[tuple[str, int, str, str]]:
    return scan.scan_text(label, line)


class FlagsLiteralCredentials(unittest.TestCase):
    """The reason the scanner exists."""

    def test_assigned_password(self):
        result = findings('ADMIN_PASS = "hunter2hunter"')
        self.assertEqual([rule for _, _, rule, _ in result], ["literal-secret (ADMIN_PASS)"])

    def test_assigned_token_single_quoted(self):
        self.assertEqual(len(findings("api_key = 'abcdef1234567890'")), 1)

    def test_provider_key_shape_is_caught_even_in_a_string(self):
        result = findings(PROVIDER_KEY_LINE)
        self.assertIn("provider-api-key", [rule for _, _, rule, _ in result])

    def test_private_key_block(self):
        result = findings(PRIVATE_KEY_LINE)
        self.assertIn("private-key-block", [rule for _, _, rule, _ in result])

    def test_low_entropy_marker_is_not_enough_on_its_own(self):
        # A sensitive *name* with an obviously short value stays quiet: the rule
        # is about literal secrets, not about the word.
        self.assertEqual(findings('password = "short"'), [])


class IgnoresCodeThatOnlyMentionsCredentials(unittest.TestCase):
    """A scanner nobody trusts is a scanner nobody keeps."""

    def test_name_inside_a_string_literal_is_not_an_assignment(self):
        self.assertEqual(findings('line.startswith("VAULT_TOKEN_FILE=")'), [])
        self.assertEqual(findings('marker = "VAULT_TOKEN_FILE="'), [])
        self.assertEqual(findings('elif line.startswith("SECRET_KEY=") and tail:'), [])

    def test_quoted_name_followed_by_a_quoted_value(self):
        self.assertEqual(findings('print("TOKEN=" + token)'), [])

    def test_field_name_value_names_a_field_not_a_secret(self):
        self.assertEqual(findings('SECRET_KEY = "INITIAL_PASSWORD"'), [])

    def test_vault_reference_is_a_pointer(self):
        self.assertEqual(findings('db_password = "vault://plutus/db#password"'), [])

    def test_interpolation_is_configuration(self):
        self.assertEqual(findings('SMTP_PASSWORD = "${SMTP_PASSWORD}"'), [])

    def test_placeholder_is_configuration(self):
        self.assertEqual(findings('ADMIN_PASSWORD = "change-me-please"'), [])

    def test_namespaced_storage_key_is_naming_a_key(self):
        self.assertEqual(findings('STORAGE_KEY = "studio.token"'), [])


class ToleratesTestFixtures(unittest.TestCase):
    def test_literal_assignment_is_relaxed_under_a_test_path(self):
        self.assertEqual(findings('ADMIN_PASS = "hunter2hunter"', label="tests/test_api.py"), [])

    def test_provider_key_shape_is_still_caught_in_a_test(self):
        result = findings(PROVIDER_KEY_LINE, label="tests/test_api.py")
        self.assertIn("provider-api-key", [rule for _, _, rule, _ in result])


class ReportsPositionAndMasksTheValue(unittest.TestCase):
    def test_line_number_is_one_based(self):
        result = scan.scan_text("src/thing.py", 'ok = 1\nADMIN_PASS = "hunter2hunter"\n')
        self.assertEqual([number for _, number, _, _ in result], [2])

    def test_the_secret_is_never_re_printed(self):
        result = scan.scan_text("src/thing.py", 'ADMIN_PASS = "hunter2hunter"')
        masked = result[0][3]
        self.assertNotIn("hunter2hunter", masked)
        self.assertTrue(masked.startswith("hu") and masked.endswith("er"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
