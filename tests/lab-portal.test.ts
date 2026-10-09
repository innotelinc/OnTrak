/**
 * What the lab's pages read, ported from `tests/test_portal.py`.
 *
 * The Python asserted these through rendered HTML: log in, start a session, GET the page,
 * `assert session.host_ip in page`. That is the right end-to-end check and the wrong unit
 * one — it needed a portal, a store, a manager and a hypervisor to answer "what does the
 * page say a Linux machine is reached by". The port keeps the *assertions* and drops the
 * scaffolding: the read models are pure, so the address, the status body, the catalogue
 * groups and both CSVs are asserted directly, and the page-level checks that genuinely
 * need a request stay in the browser suite.
 *
 * The two behaviours worth pointing at, because they were bug fixes rather than features:
 * every address form carries `LAB_NETWORK` (the guests do not route from outside the lab's
 * bridge, so a bare `10.20.0.x` told a remote student to connect to something they cannot
 * reach), and a Linux guest with no sshd has no console at all rather than an iframe that
 * never opens.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSettings } from "../src/lib/lab/config";
import { loadCatalog, loadLessons, loadScenarios } from "../src/lib/lab/dataset";
import {
  LAB_NETWORK,
  RESULTS_CSV_FILENAME,
  catalogueByCategory,
  consoleUrl,
  csvHeaders,
  leaderboardCsv,
  leaderboardRows,
  lessonIndex,
  machineAddress,
  resultsCsv,
  sessionStatus,
  workloadGroups,
} from "../src/lib/lab/portal";
import { newLabSession, type LabSession } from "../src/lib/lab/models";

const SCENARIO = "net-dns-failure";
const LINUX_SCENARIO = "linux-ownership-chown-repair";

const repository = loadScenarios();
const catalog = loadCatalog();
const lessons = loadLessons();

/** Settings with nothing particular switched on: the lab's own defaults. */
function settings(env: Record<string, string | undefined> = {}): ReturnType<typeof loadSettings> {
  return loadSettings({ env });
}

function sessionWith(fields: Partial<LabSession> = {}): LabSession {
  return {
    ...newLabSession({ student: "alice", scenarioId: SCENARIO, id: 1 }),
    hostIp: "10.20.0.9",
    ...fields,
  };
}

test("portal: the session page always carries the machine address", () => {
  const windows = repository.get(SCENARIO);
  const address = machineAddress(settings(), windows, sessionWith());

  assert.equal(address.host, "10.20.0.9");
  assert.equal(address.transport, "RDP");
  assert.equal(address.target, `10.20.0.9:${settings().guest.rdpPort}`);
  // Every form is an address on the lab's bridge — nothing here routes from the internet,
  // which is what the page has to say alongside it.
  assert.equal(address.reach, LAB_NETWORK);
  assert.equal(address.user, settings().guest.user, "the Windows training account");
});

test("portal: a Linux machine says how it is reached", () => {
  const linux = repository.get(LINUX_SCENARIO);

  // Default posture: the image runs no sshd, so the shell is the guest's own console and
  // the address is all there is to hand over.
  const shell = machineAddress(settings(), linux, sessionWith({ scenarioId: LINUX_SCENARIO }));
  assert.equal(shell.transport, "shell");
  assert.equal(shell.target, "10.20.0.9");
  assert.equal(shell.user, "root", "the Linux account the template provisioned");

  // With an sshd in the image, the reachable form is the command itself.
  const ssh = machineAddress(
    settings({ ONTRAK_GUAC__LINUX_SSH: "true" }),
    linux,
    sessionWith({ scenarioId: LINUX_SCENARIO }),
  );
  assert.equal(ssh.transport, "SSH");
  assert.equal(ssh.target, `ssh root@10.20.0.9 -p ${settings().guest.sshPort}`);

  // A Windows guest on the same session is still RDP: the transport is the scenario's.
  const windows = machineAddress(settings(), repository.get(SCENARIO), sessionWith());
  assert.equal(windows.transport, "RDP");

  // Nothing to show until the guest has an address of its own.
  const empty = machineAddress(settings(), linux, sessionWith({ hostIp: "" }));
  assert.equal(empty.host, "");
  assert.equal(empty.transport, "");
  assert.equal(empty.reach, LAB_NETWORK, "the reach note is true even with no address yet");
});

test("portal: the status body is the JSON the poller reads", () => {
  const session = sessionWith({
    state: "ready",
    hintLevel: 2,
    checksRun: 3,
    bestScore: 62.5,
    // A session a student is sitting in has a deadline: `createSession` set it when the
    // row was made, which is why the status body can carry a countdown at all.
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  });
  const status = sessionStatus(session, true);

  assert.equal(status.id, 1);
  assert.equal(status.state, "ready");
  assert.equal(status.ready, true, "ready is the portal's word for a usable machine");
  assert.equal(status.hostIp, "10.20.0.9");
  assert.equal(status.checksRun, 3);
  assert.equal(status.bestScore, 62.5);
  assert.equal(status.resolved, false);
  assert.equal(status.consoleAvailable, true);
  assert.equal(status.error, "");
  assert.equal(status.timeLimitMinutes, session.timeLimitMinutes);
  // The clock, not a flag: the page derives the countdown from this and re-derives it on
  // every poll.
  assert.ok(status.secondsRemaining !== null && status.secondsRemaining > 0);

  // A state a student cannot touch is not "ready", whatever it is called.
  assert.equal(sessionStatus(sessionWith({ state: "requested" }), false).ready, false);
  assert.equal(sessionStatus(sessionWith({ state: "destroyed" }), false).ready, false);
});

test("portal: the workload picker is the catalogue's public view", () => {
  const groups = workloadGroups(catalog);
  assert.ok(groups.length > 0, "the shipped catalogue has groups");
  for (const group of groups) {
    assert.ok(group.id !== "" && group.label !== "");
    assert.ok(group.entries.length > 0, "an empty group is dropped rather than drawn");
    for (const entry of group.entries) {
      // `toPublic` is the portal-safe view: no install recipe, no media licence.
      assert.equal(typeof entry.id, "string");
      assert.equal(entry.install, undefined, "the install recipe never reaches a student");
      assert.ok(entry.resources !== undefined);
    }
  }
});

test("portal: the dashboard lists the lab's scenarios by category, at the student's hint level", () => {
  const groups = catalogueByCategory(repository);
  assert.ok(groups.length > 0);
  const total = groups.reduce((sum, group) => sum + group.scenarios.length, 0);
  assert.equal(total, 14, "every shipped scenario is listed once");

  const flat = groups.flatMap((group) => group.scenarios);
  const dns = flat.find((scenario) => scenario.id === SCENARIO);
  assert.ok(dns, "the scenario is listed");
  assert.equal(dns.category_label, groups.find((group) => group.scenarios.includes(dns))?.label);

  // Hints are earned: the public view at level 2 carries more of them than at level 0, and
  // the count is on the page either way so a student knows there are more to come.
  const earned = catalogueByCategory(repository, 2).flatMap((group) => group.scenarios);
  const atTwo = earned.find((scenario) => scenario.id === SCENARIO);
  assert.ok(atTwo);
  assert.ok(
    (atTwo.hints_revealed as string[]).length > (dns.hints_revealed as string[]).length,
    "a revealed hint reaches the page",
  );
  assert.equal(atTwo.hint_count, dns.hint_count, "the scenario's own number does not change");
});

test("portal: the lesson index filters by platform", () => {
  const all = lessonIndex(lessons);
  assert.ok(all.length > 0);
  assert.equal(all.length, lessons.list().length);

  const windows = lessonIndex(lessons, "windows");
  assert.ok(windows.length > 0);
  assert.deepEqual(
    [...new Set(windows.map((lesson) => lesson.platform))],
    ["windows"],
  );
  for (const lesson of windows) {
    assert.equal(typeof lesson.minutes, "number");
    assert.ok(lesson.commands >= 0 && lesson.exercises >= 0);
    assert.ok(Array.isArray(lesson.tags) && Array.isArray(lesson.prerequisites));
  }
});

test("portal: the leaderboard is best-per-(student, scenario), ordered as the SQL was", () => {
  const rows = leaderboardRows([
    { student: "bob", scenarioId: SCENARIO, score: 40, resolved: false },
    { student: "alice", scenarioId: SCENARIO, score: 55, resolved: false },
    { student: "alice", scenarioId: SCENARIO, score: 90, resolved: true },
    { student: "alice", scenarioId: "hw-driver-device", score: 10, resolved: false },
  ]);

  assert.deepEqual(rows, [
    { student: "alice", scenarioId: "hw-driver-device", attempts: 1, best: 10, solved: false },
    { student: "alice", scenarioId: SCENARIO, attempts: 2, best: 90, solved: true },
    { student: "bob", scenarioId: SCENARIO, attempts: 1, best: 40, solved: false },
  ]);
  // Solved is *any* resolved attempt, and the best is the best — the two are not the same
  // attempt, and a pass that came second still counts.
  assert.equal(rows[1].solved, true);
});

test("portal: both exports keep their contract, name, header and quoting", () => {
  const rows = leaderboardRows([
    { student: 'Ada, "the analyst"', scenarioId: SCENARIO, score: 87.5, resolved: true },
  ]);
  const csv = leaderboardCsv(rows);

  assert.match(csv, /^student,scenario_id,attempts,best_score,resolved\r\n/);
  // A comma and a quote in a name stay one column: quoting is how an auditor's
  // spreadsheet keeps the roster aligned.
  assert.ok(csv.includes('"Ada, ""the analyst"""'), csv);
  assert.ok(csv.endsWith(`${SCENARIO},1,87.5,yes\r\n`), csv);

  const detailed = resultsCsv([
    {
      student: "alice",
      scenarioId: SCENARIO,
      score: 82.4,
      machineScore: 75,
      ticketScore: 91.5,
      ticketWeight: 30,
      resolved: true,
      createdAt: "2026-10-09T09:31:00.000Z",
    },
    {
      student: "bob",
      scenarioId: SCENARIO,
      score: 40,
      machineScore: 40,
      ticketScore: null,
      ticketWeight: 30,
      resolved: false,
      createdAt: "2026-10-09T10:00:00.000Z",
    },
  ]);
  assert.match(
    detailed,
    /^student,scenario_id,machine_score,ticket_score,ticket_weight,final_score,resolved,submitted_at\r\n/,
  );
  assert.ok(detailed.includes("alice,net-dns-failure,75.0,91.5,30,82.4,yes,2026-10-09T09:31:00.000Z"));
  // Not submitted is an empty field, not a zero: zero is a mark a student can earn.
  assert.ok(detailed.includes("bob,net-dns-failure,40.0,,30,40.0,no,2026-10-09T10:00:00.000Z"), detailed);

  const headers = csvHeaders();
  assert.ok(headers["content-type"].startsWith("text/csv"));
  assert.equal(headers["content-disposition"], `attachment; filename=${RESULTS_CSV_FILENAME}`);
  assert.equal(RESULTS_CSV_FILENAME, "ontrak-results.csv", "the name operators know");
});

test("portal: the console link is signed, or absent, and never a dead iframe", () => {
  const guac = {
    ONTRAK_GUAC__BASE_URL: "http://console.test/guacamole/",
    ONTRAK_GUAC__SECRET_KEY: "b".repeat(32),
  };
  const windows = repository.get(SCENARIO);
  const linux = repository.get(LINUX_SCENARIO);
  const session = sessionWith({ rdpUser: "student" });

  // Nothing to sign without a key, or without a machine.
  assert.equal(consoleUrl(settings(), session, windows), "");
  assert.equal(consoleUrl(settings(guac), sessionWith({ hostIp: "" }), windows), "");
  assert.equal(consoleUrl(settings(guac), sessionWith({ scenarioId: LINUX_SCENARIO }), linux), "",
    "a Linux image with no sshd has no console, and says so instead of embedding one");

  const url = consoleUrl(settings(guac), session, windows);
  assert.ok(url.startsWith("http://console.test/guacamole/#/?data="), url);

  // And the Linux console exists exactly when the image runs an sshd.
  const ssh = consoleUrl(
    settings({ ...guac, ONTRAK_GUAC__LINUX_SSH: "true" }),
    sessionWith({ scenarioId: LINUX_SCENARIO }),
    linux,
  );
  assert.ok(ssh.startsWith("http://console.test/guacamole/#/?data="), ssh);
});
