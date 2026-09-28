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
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db, scheduler  # noqa: E402
from ontrak.config import (  # noqa: E402
    Host,
    Settings,
    _env,
    _env_bool,
    _env_int,
    _parse_hosts,
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
        # most of the estate is.
        self.assertEqual("incus", hosts[1].kind)
        self.assertEqual("root", hosts[1].ssh_user)

    def test_a_user_can_be_named(self):
        host = _parse_hosts("i1=192.168.1.51:incus:admin")[0]
        self.assertEqual("admin", host.ssh_user)

    def test_whitespace_and_empty_entries_are_tolerated(self):
        hosts = _parse_hosts(" i1=192.168.1.51:both , , i2=192.168.1.52:both ")
        self.assertEqual(("i1", "i2"), tuple(h.name for h in hosts))

    def test_an_unset_list_falls_back_to_the_estate(self):
        # Unset means "the estate this ships for", not "scan nothing": a service
        # that scans nothing looks identical to an estate that is fully patched.
        self.assertEqual(3, len(_parse_hosts("")))

    def test_a_malformed_entry_is_an_error_not_a_dropped_host(self):
        with self.assertRaises(ValueError):
            _parse_hosts("i1,i2=192.168.1.52")


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
        # A service that can install packages estate-wide must not come up
        # answering unauthenticated requests while somebody remembers to set a
        # token, so the empty string is the only fallback — and the API refuses to
        # start on it.
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual("", Settings.from_env().api_token)


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
