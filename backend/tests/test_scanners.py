#!/usr/bin/env python3
"""Unit tests for ontrak/scanners.py — deciding what is behind.

These are the parsers whose mistakes are silent. A parser that throws is a bad
five minutes; a parser that quietly drops a line it did not recognise reports an
estate as patched while it drifts, which is the failure this whole project exists
to remove. So the cases here are mostly about the *awkward* inputs: output shapes
that changed, packages with no archive, images with no registry, and the
three-valued docker comparison where "cannot tell" must never collapse into
"up to date".

The apt fixtures are real `apt-get -s upgrade` and `apt list --upgradable` output
from Ubuntu noble, kept verbatim including the trailing summary block, because the
things that break these parsers are the lines around the parsed ones.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import scanners  # noqa: E402


SIMULATE = """\
NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
      Keep also in mind that locking is deactivated,
      so don't depend on the relevance to the real current situation!
Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  base-files curl libc6 nginx
4 upgraded, 0 newly installed, 0 to remove and 3 not upgraded.
Inst base-files [13ubuntu10.1] (13ubuntu10.2 Ubuntu:24.04/noble-updates [amd64])
Inst curl [8.5.0-2ubuntu10.1] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-security [amd64])
Inst libc6 [2.39-0ubuntu8.3] (2.39-0ubuntu8.5 Ubuntu:24.04/noble-security [amd64])
Inst nginx [1.24.0-2ubuntu7] (1.24.0-2ubuntu7.1 Ubuntu:24.04/noble-updates [amd64])
Conf base-files (13ubuntu10.2 Ubuntu:24.04/noble-updates [amd64])
Conf curl (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-security [amd64])
"""

SIMULATE_HELD = """\
Reading package lists...
Building dependency tree...
Inst linux-image-generic (6.8.0-45.45 Ubuntu:24.04/noble-security [amd64])
Inst libssl3t64 [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates [amd64])
"""

# Copied verbatim from the estate's first real scan, where every one of these
# lines came back as `unparsed`. A package published in both an updates and a
# security pocket is printed with TWO archives where the original pattern allowed
# one — and that is the security case, so the parser was rejecting exactly the
# lines that mattered most. The third line is the unrelated shape that proves the
# fix did not go too far: a third-party archive, one archive, no security.
SIMULATE_TWO_ARCHIVES = """\
Reading package lists...
Inst libc-devtools [2.39-0ubuntu8.8] (2.39-0ubuntu8.9 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Inst perl [5.34.0-3ubuntu1.8] (5.34.0-3ubuntu1.9 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64]) [perl:amd64 ]
Inst docker-ce-cli [5:29.7.2-1~ubuntu.24.04~noble] (5:29.8.1-1~ubuntu.24.04~noble Docker CE:noble [amd64])
Inst nginx-core [1.24.0-2ubuntu7] (1.24.0-2ubuntu7.1 [amd64])
"""

UPGRADABLE = """\
Listing...
base-files/noble-updates 13ubuntu10.2 amd64 [upgradable from: 13ubuntu10.1]
curl/noble-security 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.1]
libc6/noble-security 2.39-0ubuntu8.5 amd64 [upgradable from: 2.39-0ubuntu8.3]
nginx/noble-updates 1.24.0-2ubuntu7.1 amd64 [upgradable from: 1.24.0-2ubuntu7]
"""

SNAP = """\
Name    Version   Rev    Tracking       Publisher   Notes
core20  20240416  2318   latest/stable  canonical✓  base
lxd     5.21.1    29346  5.21/stable    canonical✓  -
"""

MANIFEST_LIST = """\
[
  {
    "Ref": "docker.io/library/nginx@sha256:deadbeef",
    "Descriptor": {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:amd64digest",
      "size": 1234,
      "platform": {"architecture": "amd64", "os": "linux"}
    }
  },
  {
    "Ref": "docker.io/library/nginx@sha256:deadbeef",
    "Descriptor": {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:arm64digest",
      "size": 1230,
      "platform": {"architecture": "arm64", "os": "linux"}
    }
  }
]
"""

MANIFEST_SINGLE = """\
{
  "Ref": "ghcr.io/innotelinc/thing@sha256:cafebabe",
  "Descriptor": {
    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
    "digest": "sha256:singledigest",
    "size": 900
  }
}
"""


class AptSimulation(unittest.TestCase):
    def test_it_reads_the_candidate_and_the_archive(self):
        updates, unparsed = scanners.parse_apt_simulate(SIMULATE)
        self.assertEqual([], unparsed)
        by_name = {u.package: u for u in updates}
        self.assertEqual({"base-files", "curl", "libc6", "nginx"}, set(by_name))
        self.assertEqual("13ubuntu10.1", by_name["base-files"].current)
        self.assertEqual("13ubuntu10.2", by_name["base-files"].candidate)
        self.assertEqual("Ubuntu:24.04/noble-updates", by_name["base-files"].detail)

    def test_the_archive_decides_what_is_a_security_update(self):
        updates, _ = scanners.parse_apt_simulate(SIMULATE)
        by_name = {u.package: u for u in updates}
        self.assertTrue(by_name["curl"].security)
        self.assertTrue(by_name["libc6"].security)
        self.assertFalse(by_name["nginx"].security)
        self.assertFalse(by_name["base-files"].security)

    def test_the_summary_and_conf_lines_are_not_mistaken_for_installs(self):
        # Only `Inst` lines are findings; the `Conf` block and the count summary
        # are the same upgrade described again, and counting them would double
        # every finding.
        updates, _ = scanners.parse_apt_simulate(SIMULATE)
        self.assertEqual(4, len(updates))

    def test_a_package_with_no_installed_version_still_parses(self):
        # A held-back package can appear with no `[old]` — it has no candidate
        # installed yet. Dropping it would hide the update entirely.
        updates, unparsed = scanners.parse_apt_simulate(SIMULATE_HELD)
        self.assertEqual([], unparsed)
        by_name = {u.package: u for u in updates}
        self.assertEqual("", by_name["linux-image-generic"].current)
        self.assertEqual("6.8.0-45.45", by_name["linux-image-generic"].candidate)
        self.assertTrue(by_name["linux-image-generic"].security)
        self.assertFalse(by_name["libssl3t64"].security)

    def test_an_unrecognised_inst_line_is_reported_not_dropped(self):
        # This is the canary for a distribution changing its format. Silence here
        # would mean the whole estate reads as patched.
        text = SIMULATE + "Inst we-irre-parsed this wrongly\n"
        updates, unparsed = scanners.parse_apt_simulate(text)
        self.assertEqual(4, len(updates))
        self.assertEqual(["Inst we-irre-parsed this wrongly"], unparsed)

    def test_empty_output_is_no_updates_and_no_complaint(self):
        updates, unparsed = scanners.parse_apt_simulate("")
        self.assertEqual([], updates)
        self.assertEqual([], unparsed)

    def test_a_package_in_two_archives_parses_and_the_security_one_counts(self):
        # The regression this file was missing. `noble-updates, noble-security` is
        # two tokens; matching one made the simulation contribute nothing at all on
        # a real estate, and the security flag then depended entirely on the
        # cross-check.
        updates, unparsed = scanners.parse_apt_simulate(SIMULATE_TWO_ARCHIVES)
        self.assertEqual([], unparsed)
        by_name = {u.package: u for u in updates}
        self.assertEqual(4, len(by_name))
        self.assertTrue(by_name["libc-devtools"].security)
        self.assertEqual("2.39-0ubuntu8.9", by_name["libc-devtools"].candidate)
        self.assertEqual("Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security",
                         by_name["libc-devtools"].detail)

    def test_a_third_party_archive_is_not_treated_as_security(self):
        updates, _ = scanners.parse_apt_simulate(SIMULATE_TWO_ARCHIVES)
        by_name = {u.package: u for u in updates}
        self.assertFalse(by_name["docker-ce-cli"].security)
        self.assertEqual("Docker CE:noble", by_name["docker-ce-cli"].detail)

    def test_the_trailing_architecture_bracket_is_not_an_archive(self):
        # `(1.24.0-2ubuntu7.1 [amd64])` has no archive column at all. Reading the
        # architecture as one would put a meaningless value on the finding and, on
        # a distribution that named an architecture `security`, invent an alarm.
        updates, _ = scanners.parse_apt_simulate(SIMULATE_TWO_ARCHIVES)
        by_name = {u.package: u for u in updates}
        self.assertEqual("", by_name["nginx-core"].detail)
        self.assertFalse(by_name["nginx-core"].security)
        self.assertEqual("1.24.0-2ubuntu7.1", by_name["nginx-core"].candidate)

    def test_a_dependency_note_after_the_column_is_ignored(self):
        # `... [amd64]) [perl:amd64 ]` — apt's tail noting what pulled it in. It is
        # not part of the archive and must not end up in the detail.
        updates, _ = scanners.parse_apt_simulate(SIMULATE_TWO_ARCHIVES)
        by_name = {u.package: u for u in updates}
        self.assertEqual("Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security",
                         by_name["perl"].detail)


class AptListing(unittest.TestCase):
    def test_it_reads_name_suite_candidate_and_old_version(self):
        updates, unparsed = scanners.parse_apt_upgradable(UPGRADABLE)
        self.assertEqual([], unparsed)
        by_name = {u.package: u for u in updates}
        self.assertEqual(4, len(by_name))
        self.assertEqual("8.5.0-2ubuntu10.6", by_name["curl"].candidate)
        self.assertEqual("8.5.0-2ubuntu10.1", by_name["curl"].current)
        self.assertTrue(by_name["curl"].security)

    def test_the_listing_header_is_skipped_not_reported_as_unparsed(self):
        updates, unparsed = scanners.parse_apt_upgradable(UPGRADABLE)
        self.assertEqual([], unparsed)
        self.assertEqual(4, len(updates))


class AptMerge(unittest.TestCase):
    def test_the_union_covers_a_package_only_the_listing_saw(self):
        # A phased update is held back in the simulation but visible to `apt list`.
        # It is still an update the operator should see.
        sim, _ = scanners.parse_apt_simulate(SIMULATE)
        listed, _ = scanners.parse_apt_upgradable(
            UPGRADABLE + "openssl/noble-updates 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.1]\n"
        )
        merged = scanners.merge_apt(sim, listed)
        self.assertEqual(5, len(merged))
        self.assertIn("openssl", {u.package for u in merged})

    def test_a_security_flag_from_either_view_wins(self):
        # The safe direction: a false alarm is a glance, a missed one is a CVE fix
        # filed as routine.
        sim, _ = scanners.parse_apt_simulate(SIMULATE)
        listed, _ = scanners.parse_apt_upgradable(
            "nginx/noble-security 1.24.0-2ubuntu7.1 amd64 [upgradable from: 1.24.0-2ubuntu7]\n"
        )
        merged = {u.package: u for u in scanners.merge_apt(sim, listed)}
        self.assertTrue(merged["nginx"].security)

    def test_security_findings_sort_first(self):
        sim, _ = scanners.parse_apt_simulate(SIMULATE)
        merged = scanners.merge_apt(sim, [])
        self.assertEqual(["curl", "libc6", "base-files", "nginx"], [u.package for u in merged])

    def test_one_row_per_package_even_when_both_views_agree(self):
        sim, _ = scanners.parse_apt_simulate(SIMULATE)
        listed, _ = scanners.parse_apt_upgradable(UPGRADABLE)
        merged = scanners.merge_apt(sim, listed)
        self.assertEqual(len({u.package for u in merged}), len(merged))


class SecuritySuiteDetection(unittest.TestCase):
    def test_real_security_pockets_are_recognised(self):
        for suite in ("noble-security", "Ubuntu:24.04/noble-security", "bookworm-security",
                      "jammy-security", "security"):
            with self.subTest(suite=suite):
                self.assertTrue(scanners.is_security_suite(suite))

    def test_feature_pockets_are_not_mistaken_for_security(self):
        for suite in ("noble-updates", "noble", "Ubuntu:24.04/noble-updates", "bookworm",
                      "jammy-backports", ""):
            with self.subTest(suite=suite):
                self.assertFalse(scanners.is_security_suite(suite))


class Snap(unittest.TestCase):
    def test_it_reads_the_pending_refresh(self):
        updates, unparsed = scanners.parse_snap_refresh(SNAP)
        self.assertEqual([], unparsed)
        by_name = {u.package: u for u in updates}
        self.assertEqual({"core20", "lxd"}, set(by_name))
        self.assertEqual("20240416", by_name["core20"].candidate)

    def test_no_refreshes_available_is_not_an_error(self):
        updates, unparsed = scanners.parse_snap_refresh("No refreshes available\n")
        self.assertEqual([], updates)
        self.assertEqual([], unparsed)

    def test_all_snaps_up_to_date_is_not_an_error(self):
        # The other way snap says it has nothing to do, and the one the estate
        # actually prints. It was reported as unparsed output, so every host with
        # snap installed carried a `partial` snap manager and an error line for the
        # most ordinary state there is.
        updates, unparsed = scanners.parse_snap_refresh("All snaps up to date.\n")
        self.assertEqual([], updates)
        self.assertEqual([], unparsed)

    def test_snap_not_installed_is_empty_rather_than_unparsed_noise(self):
        updates, unparsed = scanners.parse_snap_refresh("")
        self.assertEqual([], updates)
        self.assertEqual([], unparsed)


class DockerDigests(unittest.TestCase):
    def test_a_local_repo_digest_is_read_out_of_the_json(self):
        self.assertEqual("sha256:abc123",
                         scanners.parse_repo_digest('["nginx@sha256:abc123"]'))

    def test_a_locally_built_image_has_no_digest(self):
        # This is the common case in this estate (`:local` images). It must be ""
        # so the comparison above it can say "unjudged".
        self.assertEqual("", scanners.parse_repo_digest("[]"))
        self.assertEqual("", scanners.parse_repo_digest("<none>"))
        self.assertEqual("", scanners.parse_repo_digest(""))

    def test_a_manifest_list_returns_the_platform_digest_not_the_list_digest(self):
        # The list's own digest changes when *any* platform is republished,
        # including ones this host does not run — comparing against it would report
        # a spurious update every time an arm64 build landed.
        self.assertEqual("sha256:amd64digest", scanners.parse_manifest_digest(MANIFEST_LIST))
        self.assertEqual("sha256:arm64digest",
                         scanners.parse_manifest_digest(MANIFEST_LIST, arch="arm64"))

    def test_a_single_arch_manifest_returns_its_digest(self):
        self.assertEqual("sha256:singledigest", scanners.parse_manifest_digest(MANIFEST_SINGLE))

    def test_an_unreadable_manifest_is_empty_not_a_guess(self):
        for text in ("", "not json", "null", "{}", "[{\"Descriptor\": {}}]"):
            with self.subTest(text=text):
                self.assertEqual("", scanners.parse_manifest_digest(text))


class BehindComparison(unittest.TestCase):
    def test_a_different_digest_is_behind(self):
        self.assertTrue(scanners.image_is_behind("sha256:old", "sha256:new"))

    def test_the_same_digest_is_current(self):
        self.assertFalse(scanners.image_is_behind("sha256:same", "sha256:same"))

    def test_an_unknown_digest_is_neither_current_nor_behind(self):
        # THREE-VALUED ON PURPOSE. A local-only image, a registry that refused a
        # token and a rate-limited Docker Hub all land here. Collapsing this into
        # False would report an entire estate as up to date the first time a
        # registry said no.
        self.assertIsNone(scanners.image_is_behind("", "sha256:new"))
        self.assertIsNone(scanners.image_is_behind("sha256:old", ""))
        self.assertIsNone(scanners.image_is_behind("", ""))


class ComposeImages(unittest.TestCase):
    def test_service_to_image_is_read_from_compose_config_json(self):
        text = '{"services": {"n8n": {"image": "docker.n8n.io/n8nio/n8n:1.60.0"}, "db": {}}}'
        self.assertEqual({"n8n": "docker.n8n.io/n8nio/n8n:1.60.0"},
                         scanners.parse_compose_images(text))

    def test_an_unreadable_config_yields_nothing_rather_than_raising(self):
        self.assertEqual({}, scanners.parse_compose_images("not json"))
        self.assertEqual({}, scanners.parse_compose_images(""))


if __name__ == "__main__":
    unittest.main()
