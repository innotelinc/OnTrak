#!/usr/bin/env python3
"""Unit tests for ontrak/config.py — how `.env` becomes settings.

This file exists because the configuration layer is where Ontrak Sync fails
QUIETLY. Everything else in the service fails with a message a person can act on:
a scan reports an unreachable host, an apply reports a failed package. Config
mistakes do not — a schedule that arrives with its quotes still attached is a timer
that simply never fires, and an invalid mode is a settings form that refuses every
save for no visible reason.

The two things pinned here:

  * **quoted values.** `.env` is read by docker compose, by `docker run --env-file`
    and by a shell (through `make scan`), and those three do not agree about quotes.
    `ONTRAK_DEFAULT_SCHEDULE` contains spaces, so it has to be quoted to survive the
    shell, and the quotes have to come off for the other readers.
  * **the first policy.** `ONTRAK_DEFAULT_SCHEDULE`/`ONTRAK_DEFAULT_MODE` seed the
    policy that exists before the settings form has ever been saved, and get out of
    the way afterwards. A default that is read and never used is how somebody
    concludes the knob is broken — so the seeding, and the precedence, are asserted
    rather than assumed.
"""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db, scheduler  # noqa: E402
from ontrak.config import (  # noqa: E402
    DEFAULT_HOSTS,
    Host,
    RegistryCredential,
    Settings,
    _env,
    _env_bool,
    _env_int,
    _parse_hosts,
    _parse_registry_credentials,
    normalize_registry,
    WORKLOAD_KINDS,
)
from ontrak.policy import Policy  # noqa: E402


class Env(unittest.TestCase):
    """`_env` and the typed readers built on it."""

    def read(self, value: str) -> str:
        with mock.patch.dict(os.environ, {"ONTRAK_PROBE": value}):
            return _env("ONTRAK_PROBE")

    def test_an_unquoted_value_is_taken_as_it_is(self):
        self.assertEqual("detect", self.read("detect"))

    def test_a_matching_pair_of_quotes_is_unwrapped(self):
        self.assertEqual("0 4 * * 0", self.read('"0 4 * * 0"'))
        self.assertEqual("0 4 * * 0", self.read("'0 4 * * 0'"))

    def test_a_lone_quote_is_not_a_wrapper(self):
        # Only a MATCHING pair is a quote. A value that merely starts with one is
        # left whole rather than half-eaten, because eating it would silently change
        # a value somebody typed on purpose.
        self.assertEqual('"0 4 * * 0', self.read('"0 4 * * 0'))
        self.assertEqual('0 4 * * 0"', self.read('0 4 * * 0"'))
        self.assertEqual('"', self.read('"'))

    def test_whitespace_around_a_quoted_value_is_trimmed(self):
        self.assertEqual("0 4 * * 0", self.read('   "0 4 * * 0"   '))

    def test_typed_readers_accept_a_quoted_value(self):
        with mock.patch.dict(os.environ, {"ONTRAK_N": '"300"', "ONTRAK_B": "'true'"}):
            self.assertEqual(300, _env_int("ONTRAK_N", 20))
            self.assertTrue(_env_bool("ONTRAK_B", False))

    def test_an_absent_value_falls_back_to_the_default(self):
        self.assertEqual("fallback", _env("ONTRAK_DEFINITELY_NOT_SET", "fallback"))

    def test_an_explicitly_empty_value_stays_empty(self):
        # `ONTRAK_API_TOKEN=` has to mean "no token" rather than "whatever the
        # default is", so an empty value is a value. For the token that difference
        # is the one that keeps an unconfigured service from starting.
        with mock.patch.dict(os.environ, {"ONTRAK_PROBE": ""}):
            self.assertEqual("", _env("ONTRAK_PROBE", "fallback"))


class Hosts(unittest.TestCase):
    """`ONTRAK_HOSTS` — the only place that says what this deployment covers."""

    def test_the_documented_shape_parses(self):
        hosts = _parse_hosts("i1=192.168.1.51:both,i2=192.168.1.52")
        self.assertEqual(("i1", "i2"), tuple(h.name for h in hosts))
        self.assertEqual("both", hosts[0].kind)
        # Kind and user are optional; an absent kind is an incus host, which is what
        # most of the Network is.
        self.assertEqual("incus", hosts[1].kind)
        self.assertEqual("root", hosts[1].ssh_user)

    def test_a_user_can_be_named(self):
        host = _parse_hosts("i1=192.168.1.51:incus:admin")[0]
        self.assertEqual("admin", host.ssh_user)

    def test_whitespace_and_empty_entries_are_tolerated(self):
        hosts = _parse_hosts(" i1=192.168.1.51:both , , i2=192.168.1.52:both ")
        self.assertEqual(("i1", "i2"), tuple(h.name for h in hosts))

    def test_an_unset_list_falls_back_to_the_network(self):
        # Unset means "the Network this ships for", not "scan nothing": a service
        # that scans nothing looks identical to a Network that is fully patched.
        hosts = _parse_hosts("")
        self.assertEqual(("i1", "i2", "i3", "i4", "pm3", "pm4"),
                         tuple(h.name for h in hosts))

    def test_the_hypervisors_are_scanned_as_machines(self):
        # pm3/pm4 carry their own Proxmox packages and are NOT workload kinds, so
        # `scan.py` reaches them over SSH as machines rather than asking them for
        # `incus list` (which they would answer with nothing).
        proxmox = [h for h in _parse_hosts("") if h.kind == "proxmox"]
        self.assertEqual({"pm3", "pm4"}, {h.name for h in proxmox})
        for host in proxmox:
            self.assertNotIn(host.kind, WORKLOAD_KINDS)

    def test_a_malformed_entry_is_an_error_not_a_dropped_host(self):
        with self.assertRaises(ValueError):
            _parse_hosts("i1,i2=192.168.1.52")


class RegistryCredentials(unittest.TestCase):
    """`ONTRAK_REGISTRY_CREDENTIALS` — the fix for Docker Hub's shared budget.

    Docker Hub answers anonymous pulls out of the same small per-address budget the
    scans spend, which is why an update fails with `429` on a Network whose scanning
    side is already careful. A configured credential is the other half, so the two
    things worth pinning are that a credential is filed under a *canonical* registry
    name (or a Hub alias would never match a bare ref), and that a malformed entry is
    dropped rather than half-parsed into a credential that authenticates as nobody.
    """

    def test_every_docker_hub_spelling_folds_together(self):
        for alias in ("docker.io", "index.docker.io", "registry-1.docker.io",
                      "registry.hub.docker.com", "DOCKER.IO"):
            self.assertEqual("docker.io", normalize_registry(alias))

    def test_a_scheme_and_trailing_slash_are_tolerated(self):
        self.assertEqual("ghcr.io", normalize_registry("https://ghcr.io/"))
        self.assertEqual("ghcr.io", normalize_registry("  ghcr.io  "))

    def test_the_documented_shape_parses(self):
        creds = _parse_registry_credentials("docker.io dhunter dckr_pat_x")
        self.assertEqual((RegistryCredential("docker.io", "dhunter", "dckr_pat_x"),), creds)

    def test_a_token_may_contain_equals_and_colons(self):
        # A real registry token does, which is why the fields are whitespace-separated
        # rather than split on `=` or `:` — either of those would truncate the secret.
        creds = _parse_registry_credentials("docker.io dhunter dckr_pat_a=b:c")
        self.assertEqual("dckr_pat_a=b:c", creds[0].password)

    def test_newlines_commas_and_comments_are_tolerated(self):
        creds = _parse_registry_credentials(
            "# a comment\ndocker.io dhunter a=b, ghcr.io alice ghp_x\n\n")
        self.assertEqual(("docker.io", "ghcr.io"), tuple(c.registry for c in creds))

    def test_a_malformed_entry_is_dropped(self):
        self.assertEqual((), _parse_registry_credentials("docker.io dhunter"))
        self.assertEqual((), _parse_registry_credentials("docker.io d h extra"))

    def test_the_password_never_appears_in_the_repr(self):
        # A credential is a field of `Settings`, so any `repr(settings)` (a log line, a
        # traceback) would otherwise print the token.
        credential = RegistryCredential("docker.io", "dhunter", "dckr_pat_secret")
        self.assertNotIn("dckr_pat_secret", repr(credential))
        self.assertIn("dhunter", repr(credential))

    def test_a_credential_is_found_by_its_canonical_name(self):
        settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),),
                            registry_credentials=(RegistryCredential("docker.io", "a", "b"),))
        self.assertIsNotNone(settings.credential_for("index.docker.io"))
        self.assertIsNone(settings.credential_for("ghcr.io"))

    def test_it_is_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {"ONTRAK_REGISTRY_CREDENTIALS": "ghcr.io alice ghp_x"}):
            settings = Settings.from_env()
        self.assertEqual("alice", settings.credential_for("ghcr.io").username)

    def test_absent_means_anonymous(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual((), Settings.from_env().registry_credentials)

    def test_the_login_reuse_ttl_defaults_to_a_week(self):
        # The daemon keeps the credential, so the default is long enough to skip the
        # scheduled scans yet short enough to pick up a rotated token soon after the
        # next apply — which authenticates unconditionally.
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(7 * 24 * 3600, Settings.from_env().login_ttl_seconds)

    def test_the_login_reuse_ttl_is_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {"ONTRAK_LOGIN_TTL": "3600"}):
            self.assertEqual(3600, Settings.from_env().login_ttl_seconds)


class SetupScript(unittest.TestCase):
    """`scripts/setup.sh` must authorise the key on exactly the hosts config scans.

    The two lists are kept in step by hand, and the way they drift is silent: a
    host that is scanned but never authorised reads as "unreachable" in the
    dashboard rather than as the configuration mistake it is, and the one host
    that would have explained it is the one that cannot connect. This is the check
    that notices, so the list is a fact with a test rather than a comment asking
    somebody to remember.

    It skips inside the backend image, which ships `ontrak` and `tests` only:
    setup.sh is a repo script that never runs there, so its absence is not a failure.
    """

    def _default_addresses(self) -> list[str]:
        script = Path(__file__).resolve().parents[2] / "scripts" / "setup.sh"
        if not script.exists():
            self.skipTest("scripts/setup.sh ships with the repo, not the image")
        match = re.search(
            r'^NETWORK_HOSTS="\$\{NETWORK_HOSTS:-([^}]*)\}"',
            script.read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        self.assertIsNotNone(match, "setup.sh must define a NETWORK_HOSTS default")
        return match.group(1).split()

    def test_it_authorises_the_same_hosts_the_config_scans(self):
        self.assertEqual([h.address for h in DEFAULT_HOSTS], self._default_addresses())


class Defaults(unittest.TestCase):
    """The environment as it reaches `Settings`."""

    def test_the_default_mode_is_one_the_policy_accepts(self):
        # Regression: this fallback used to be `"scan"`, which is not a mode. It
        # never showed up in a configured deployment because `.env` sets the value,
        # and it broke exactly the deployment that trusted the default.
        with mock.patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()
        self.assertEqual("detect", settings.default_mode)
        self.assertEqual([], Policy(mode=settings.default_mode,
                                    schedule=settings.default_schedule).validate())

    def test_the_token_has_no_default(self):
        # A service that can install packages Network-wide must not come up
        # answering unauthenticated requests while somebody remembers to set a
        # token, so the empty string is the only fallback — and the API refuses to
        # start on it.
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual("", Settings.from_env().api_token)

    def test_apt_gets_a_longer_clock_than_a_probe(self):
        # Two ceilings for two kinds of work. Re-tying them to the same number brings
        # back the run that reported 306 failed packages on hosts that were patched.
        with mock.patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()
        self.assertGreater(settings.apt_timeout, settings.command_timeout)
        with mock.patch.dict(os.environ, {"ONTRAK_APT_TIMEOUT": "1800"}):
            self.assertEqual(1800, Settings.from_env().apt_timeout)

    def test_an_image_pull_gets_a_longer_clock_than_a_probe(self):
        # The third long job, for the same reason as apt: a download sized like a
        # probe fails for being slow, and the PBX full-stack image failed that way at
        # every apply.
        with mock.patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()
        self.assertGreater(settings.pull_timeout, settings.command_timeout)
        with mock.patch.dict(os.environ, {"ONTRAK_PULL_TIMEOUT": "2400"}):
            self.assertEqual(2400, Settings.from_env().pull_timeout)


class FirstPolicy(unittest.TestCase):
    """Seeding the policy that exists before the form has ever been saved."""

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),),
                                 default_schedule="0 4 * * 0", default_mode="detect")

    def test_an_empty_database_is_seeded_from_the_environment(self):
        policy = scheduler.load_policy(self.conn, self.settings)
        self.assertEqual("0 4 * * 0", policy.schedule)
        self.assertEqual("detect", policy.mode)

    def test_the_environment_seeds_a_schedule_the_timer_can_parse(self):
        # The whole point of honouring the variable is that the very first timer run
        # works. A default that does not parse is a timer that never fires.
        policy = scheduler.load_policy(self.conn, self.settings)
        self.assertEqual([], policy.validate())

    def test_a_saved_policy_wins_over_the_environment(self):
        saved = Policy(mode="auto", schedule="30 2 * * 1")
        self.assertEqual([], scheduler.save_policy(self.conn, saved))
        policy = scheduler.load_policy(self.conn, self.settings)
        self.assertEqual("30 2 * * 1", policy.schedule)
        self.assertEqual("auto", policy.mode)

    def test_the_settings_are_optional(self):
        # A caller with no `Settings` still gets a usable policy — the class
        # defaults — rather than an exception.
        policy = scheduler.load_policy(self.conn)
        self.assertEqual("detect", policy.mode)
        self.assertEqual(Policy().schedule, policy.schedule)


if __name__ == "__main__":
    unittest.main()
