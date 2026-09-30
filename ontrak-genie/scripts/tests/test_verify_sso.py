#!/usr/bin/env python3
"""Tests for scripts/verify-sso.py — Genie's sign-in posture check.

The half that matters can only be proved against a live IdP, and this file does not
try: it tests everything that decides *what* the check does, which is where a wrong
answer would make a green run mean nothing.

  * config is read from the environment first, then this repo's `.env` — and the
    defaults are the family's deployment, so a bare run on the estate still asks
    about the real name
  * the expected redirect URI is *this* name's callback, which is the check that
    catches a provider registration that drifted
  * a redirect is handed back rather than followed, because the hops are the check
  * no admin token is a SKIP (exit 2), never a failure (exit 1) — an unreachable
    deployment and a broken one must not look alike to the runner
"""

import argparse
import importlib.util
import io
import os
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "verify-sso.py"


def load_module():
    spec = importlib.util.spec_from_file_location("verify_sso", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify_sso = load_module()


def args(url=None, verbose=False):
    return argparse.Namespace(url=url, verbose=verbose)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.repo = pathlib.Path(tempfile.mkdtemp())
        self.saved = dict(os.environ)
        for key in list(os.environ):
            if key.startswith(("ONTRAK_", "AUTHENTIK_", "VERIFY_")) or key in ("OIDC_ISSUER", "OIDC_CLIENT_ID"):
                del os.environ[key]

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)

    def config(self, url=None):
        return verify_sso.Config(args(url), self.repo)

    def test_defaults_are_the_family_deployment(self):
        cfg = self.config()
        self.assertEqual(cfg.public, verify_sso.DEFAULT_PUBLIC_URL)
        self.assertEqual(cfg.issuer, verify_sso.DEFAULT_ISSUER)
        self.assertEqual(cfg.client_id, "ontrak")

    def test_repo_env_file_is_read(self):
        (self.repo / ".env").write_text(
            'ONTRAK_PUBLIC_URL="https://genie.example"\nONTRAK_OIDC_CLIENT_ID=other\n', encoding="utf-8"
        )
        cfg = self.config()
        self.assertEqual(cfg.public, "https://genie.example")
        self.assertEqual(cfg.client_id, "other")

    def test_environment_beats_the_env_file(self):
        (self.repo / ".env").write_text("ONTRAK_PUBLIC_URL=https://from-file\n", encoding="utf-8")
        os.environ["ONTRAK_PUBLIC_URL"] = "https://from-env"
        self.assertEqual(self.config().public, "https://from-env")

    def test_cli_url_beats_both(self):
        os.environ["ONTRAK_PUBLIC_URL"] = "https://from-env"
        self.assertEqual(self.config(url="https://from-cli/").public, "https://from-cli")

    def test_trailing_slash_is_trimmed(self):
        os.environ["ONTRAK_PUBLIC_URL"] = "https://genie.example/"
        self.assertEqual(self.config().public, "https://genie.example")

    def test_api_url_defaults_to_the_issuer_origin(self):
        self.assertEqual(self.config().api, "https://auth.cerulean.innotel.us")

    def test_expected_redirect_is_this_names_callback(self):
        os.environ["ONTRAK_PUBLIC_URL"] = "https://genie.example"
        self.assertEqual(self.config().expect_redirect(), "https://genie.example/api/auth/callback")

    def test_cerulean_env_is_the_last_resort_for_the_admin_token(self):
        estate = pathlib.Path(tempfile.mkdtemp())
        (estate / "cerulean").mkdir()
        (estate / "cerulean" / ".env").write_text("AUTHENTIK_BOOTSTRAP_TOKEN=from-cerulean\n", encoding="utf-8")
        repo = estate / "ontrak" / "ontrak-genie"
        repo.mkdir(parents=True)
        self.assertEqual(verify_sso.Config(args(), repo).token, "from-cerulean")


class RedirectTest(unittest.TestCase):
    def test_a_redirect_is_handed_back_rather_than_followed(self):
        handler = verify_sso.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "https://example/next"))

    def test_headers_are_matched_case_insensitively(self):
        self.assertEqual(verify_sso.lower_headers({"Location": "x"})["location"], "x")
        self.assertEqual(verify_sso.lower_headers({"location": "y"})["location"], "y")


class ExitCodeTest(unittest.TestCase):
    """The runner reads exit 2 as SKIP and anything else as a verdict."""

    def setUp(self):
        self.saved = dict(os.environ)
        self.saved_argv = list(sys.argv)
        for key in list(os.environ):
            if key.startswith(("ONTRAK_", "AUTHENTIK_", "VERIFY_")):
                del os.environ[key]

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)
        sys.argv = self.saved_argv

    def test_no_admin_token_is_a_skip_not_a_failure(self):
        sys.argv = ["verify-sso.py", "--url", "https://genie.example"]
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = verify_sso.main()
        self.assertEqual(code, 2)
        self.assertIn("no Authentik admin token", stream.getvalue())
        self.assertEqual(verify_sso.failures, [])

    def test_an_unreachable_console_is_a_skip_not_a_failure(self):
        # Port 1 on loopback: nothing can be listening, and the failure mode is
        # "cannot answer", which must not be reported as a broken deployment.
        os.environ["AUTHENTIK_BOOTSTRAP_TOKEN"] = "not-a-real-token"
        sys.argv = ["verify-sso.py", "--url", "https://127.0.0.1:1"]
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = verify_sso.main()
        self.assertEqual(code, 2)
        self.assertIn("SKIP", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
