/**
 * Engine tests.
 *
 * These exercise the parts of the product that everything else depends on:
 * the shell interpreter, each driver, the formula engine, the grader and the
 * scenario validator. Run with `npm test`.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  LINUX_ACCOUNTS_TEMPLATE,
  LINUX_NETWORK_TEMPLATE,
  OFFICE_TRIAGE_TEMPLATE,
  TEMPLATE_CHOICES,
  WINDOWS_ACCOUNTS_TEMPLATE,
  WINDOWS_DESKTOP_FILES_TEMPLATE,
  WINDOWS_DESKTOP_TEMPLATE,
} from "../src/lib/templates";
import {
  desktopCommands,
  FRAME_MIN_HEIGHT,
  FRAME_MIN_WIDTH,
  initialFrameBox,
  moveFrame,
  nameDraftCommand,
  resizeFrame,
  sanitizeName,
  updatesPaused,
} from "../src/lib/sim/desktop";
import { createDriver } from "../src/lib/sim/drivers";
import { gradeAttempt } from "../src/lib/sim/grade";
import { baseName, dirName, display, toKey } from "../src/lib/sim/paths";
import { createInitialState } from "../src/lib/sim/state";
import { validateDefinition } from "../src/lib/validate";
import { writeEditedFile } from "../src/lib/sim/vfs";
import type { ScenarioDefinition } from "../src/lib/sim/types";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const LINUX_SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Get the internal web service back online.",
  brief: "nginx is installed but not running and not enabled. Start it, enable it, and open port 80.",
  tasks: ["Start nginx", "Enable nginx at boot", "Allow HTTP through the firewall"],
  machine: { hostname: "server01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
  files: [{ path: "/home/student/README", content: "Ticket 4471: the intranet is down again.\n", mode: "644" }],
  checks: [
    { id: "svc-active", label: "nginx is running", kind: "service_state", name: "nginx", active: true, points: 2 },
    { id: "svc-enabled", label: "nginx survives a reboot", kind: "service_state", name: "nginx", enabled: true, points: 2 },
    {
      id: "fw-http",
      label: "Port 80 is allowed",
      kind: "firewall_rule",
      name: "allow-80",
      action: "allow",
      points: 1,
    },
    {
      id: "read-brief",
      label: "Read the ticket",
      kind: "command_matched",
      pattern: "cat\\s+.*README",
      points: 1,
    },
  ],
};

const WINDOWS_SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  objective: "Make the print spooler start automatically and disable RDP.",
  brief: "The spooler was set to Manual. Set it back to Automatic and stop RDP from being reachable.",
  tasks: ["Start the Spooler service", "Set it to start automatically", "Block inbound RDP"],
  machine: { hostname: "WS-01", user: "student", os: "Microsoft Windows 11 Pro", version: "10.0.22631" },
  checks: [
    { id: "spooler", label: "Spooler runs at startup", kind: "service_state", name: "Spooler", active: true, enabled: true, points: 3 },
    { id: "rdp", label: "Inbound RDP is blocked", kind: "firewall_rule", name: "Allow-RDP-TCP-In", action: "deny", points: 2 },
    { id: "policy", label: "Update policy set", kind: "registry_value", path: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate", name: "NoAutoUpdate", equals: 1, points: 1 },
  ],
};

const OFFICE_SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "OFFICE",
  engine: "office",
  objective: "Fix the quarterly budget and reply to the finance director.",
  brief: "The Q3 total in C4 is wrong and the sheet has no Q4 column. Fix the formula, then reply to the email.",
  tasks: ["Correct the SUM formula", "Reply to the finance director"],
  machine: { hostname: "workstation", user: "student", os: "Office Productivity Suite", version: "2024" },
  docs: [
    {
      type: "spreadsheet",
      name: "Q3 Budget.xlsx",
      location: "/Documents/Q3 Budget.xlsx",
      activeSheet: 0,
      sheets: [
        {
          name: "Sheet1",
          cells: {
            A1: { v: "Item" },
            B1: { v: "Q3" },
            A2: { v: "Licenses" },
            B2: { v: "1200" },
            A3: { v: "Hardware" },
            B3: { v: "2400" },
            A4: { v: "Total" },
            C4: { v: "0" },
          },
        },
      ],
    },
    {
      type: "mail",
      name: "Inbox",
      location: "/Inbox",
      messages: [
        {
          id: "M1001",
          from: "finance@ontrak.local",
          to: ["student@ontrak.local"],
          subject: "Q3 budget figures",
          body: "The total looks wrong. Can you check and confirm?",
          at: 1_700_000_000_000,
          read: false,
          flagged: false,
          folder: "inbox",
        },
      ],
    },
  ],
  checks: [
    { id: "total", label: "Q3 total is correct", kind: "cell_equals", doc: "Q3 Budget.xlsx", cell: "C4", equals: 3600, points: 3 },
    { id: "formula", label: "C4 uses SUM", kind: "cell_formula_contains", doc: "Q3 Budget.xlsx", cell: "C4", pattern: "^SUM\\(", points: 2 },
    {
      id: "reply",
      label: "Replied to finance",
      kind: "mail_sent",
      to: "finance@ontrak.local",
      subjectPattern: "Q3",
      points: 2,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  Shell interpreter                                                         */
/* -------------------------------------------------------------------------- */

test("bash: basic filesystem workflow", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  assert.match(driver.run("pwd", state).stdout ?? "", /\/home\/student/);
  assert.match(driver.run("ls", state).stdout ?? "", /README/);
  assert.match(driver.run("cat README", state).stdout ?? "", /Ticket 4471/);

  driver.run("mkdir -p projects/network", state);
  driver.run("touch projects/network/plan.md", state);
  assert.ok(state.vfs["/home/student/projects/network/plan.md"], "nested file should exist");

  driver.run("cd projects", state);
  assert.equal(state.machine.cwd, "/home/student/projects");
  driver.run("cd ~", state);
  assert.equal(state.machine.cwd, "/home/student");
});

test("bash: pipes, redirection and exit codes", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  driver.run("printf 'b\\na\\nc\\n' > letters.txt", state);
  const sorted = driver.run("sort letters.txt | head -n 2", state);
  assert.equal(sorted.stdout, "a\nb");

  driver.run("cat letters.txt >> letters.txt", state);
  assert.equal(state.vfs["/home/student/letters.txt"].content?.split("\n").length, 7);

  const failed = driver.run("ls /does-not-exist", state);
  assert.equal(failed.exitCode, 2);
  assert.match(failed.stderr ?? "", /No such file or directory/);

  // `&&` must not run the right-hand side after a failure.
  const chained = driver.run("cat /nope && echo SHOULD_NOT_APPEAR", state);
  assert.ok(!(chained.stdout ?? "").includes("SHOULD_NOT_APPEAR"));
});

test("bash: permissions and sudo", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  driver.run("touch secret.txt", state);
  driver.run("chmod 600 secret.txt", state);
  assert.equal(state.vfs["/home/student/secret.txt"].mode & 0o777, 0o600);

  // An unprivileged user cannot start a service.
  const denied = driver.run("systemctl start nginx", state);
  assert.match(denied.stderr ?? "", /root/);

  // With sudo it works, and enabling it is recorded.
  driver.run("sudo systemctl start nginx", state);
  driver.run("sudo systemctl enable nginx", state);
  const nginx = state.machine.services.find((service) => service.name === "nginx");
  assert.equal(nginx?.active, true);
  assert.equal(nginx?.enabled, true);

  // sudoers membership shows up for the grader too.
  assert.ok(state.machine.users.find((u) => u.name === "student")?.groups.includes("sudo"));
});

test("bash: users, groups and packages", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  driver.run("sudo useradd -m -s /bin/bash jsmith", state);
  assert.ok(state.machine.users.some((u) => u.name === "jsmith"));

  driver.run("sudo usermod -aG sudo jsmith", state);
  assert.ok(state.machine.users.find((u) => u.name === "jsmith")?.groups.includes("sudo"));

  driver.run("sudo apt-get install -y nginx", state);
  assert.equal(state.machine.packages.find((p) => p.name === "nginx")?.installed, true);
});

test("bash: firewall and cron", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  driver.run("sudo ufw allow 80/tcp", state);
  const rule = state.machine.firewall.find((entry) => entry.port === "80");
  assert.equal(rule?.action, "allow");

  driver.run("printf '0 3 * * * /usr/local/bin/backup.sh\\n' > /tmp/jobs", state);
  driver.run("crontab /tmp/jobs", state);
  assert.equal(state.machine.cron.at(-1)?.command, "/usr/local/bin/backup.sh");
});

/* -------------------------------------------------------------------------- */
/*  PowerShell                                                                */
/* -------------------------------------------------------------------------- */

test("powershell: services, registry and firewall", () => {
  const state = createInitialState(WINDOWS_SCENARIO);
  const standardUser = createDriver("powershell", { user: "student" });

  // A standard user can look but not touch machine-wide settings.
  const refused = standardUser.run("Set-Service -Name Spooler -StartupType Automatic", state);
  assert.match(refused.stderr ?? "", /Access is denied|PermissionDenied/);

  const driver = createDriver("powershell", { user: "Administrator" });
  assert.match(driver.run("Get-Service Spooler", state).stdout ?? "", /Spooler/);

  driver.run("Start-Service -Name Spooler", state);
  driver.run("Set-Service -Name Spooler -StartupType Automatic", state);
  const spooler = state.machine.services.find((service) => service.name === "Spooler");
  assert.equal(spooler?.active, true);
  assert.equal(spooler?.startupType, "Automatic");
  assert.equal(spooler?.enabled, true);

  driver.run('Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate" -Name NoAutoUpdate -Value 1', state);
  const policy = state.machine.registry.find((entry) => entry.name === "NoAutoUpdate");
  assert.equal(policy?.value, 1);

  driver.run('New-NetFirewallRule -DisplayName "Allow HTTPS" -LocalPort 443 -Action Allow', state);
  assert.ok(state.machine.firewall.some((rule) => rule.name === "Allow HTTPS" && rule.port === "443"));
  assert.ok(state.machine.firewall.some((rule) => rule.name === "Allow HTTPS" && rule.port === "443"));
});

test("powershell: windows path semantics", () => {
  const state = createInitialState(WINDOWS_SCENARIO);
  const driver = createDriver("powershell", { user: "student" });

  assert.equal(driver.prompt(state), "PS C:\\Users\\student>");

  driver.run("Set-Location C:\\Windows", state);
  // Casing is preserved for display, but lookups are case-insensitive.
  assert.equal(state.machine.cwd.toLowerCase(), "/c:/windows");
  assert.equal(driver.prompt(state), "PS C:\\Windows>");

  driver.run("New-Item -ItemType Directory -Path C:\\Temp\\lab -Force", state);
  assert.ok(driver.run("Test-Path C:\\Temp\\lab", state).stdout?.includes("True"));

  // Windows paths are case-insensitive.
  assert.ok(driver.run("Test-Path c:\\temp\\LAB", state).stdout?.includes("True"));
});

test("powershell: local accounts", () => {
  const state = createInitialState(WINDOWS_SCENARIO);
  const driver = createDriver("powershell", { user: "Administrator" });

  driver.run('New-LocalUser -Name helper -Password "Sup3rSecret!" -Description "Shared desk account"', state);
  assert.ok(state.machine.users.some((user) => user.name === "helper"));

  driver.run('Add-LocalGroupMember -Group "Remote Desktop Users" -Member helper', state);
  assert.ok(state.machine.users.find((user) => user.name === "helper")?.groups.includes("Remote Desktop Users"));

  driver.run("Disable-LocalUser -Name helper", state);
  assert.equal(state.machine.users.find((user) => user.name === "helper")?.enabled, false);
});

/* -------------------------------------------------------------------------- */
/*  Office                                                                    */
/* -------------------------------------------------------------------------- */

test("office: spreadsheet formulas and formatting", () => {
  const state = createInitialState(OFFICE_SCENARIO);
  const driver = createDriver("office", { user: "student" });

  assert.match(driver.run("docs", state).stdout ?? "", /Q3 Budget.xlsx/);
  driver.run("open Q3 Budget.xlsx", state);
  assert.equal(state.office.activeDoc, "Q3 Budget.xlsx");

  driver.run("formula C4 =SUM(B2:B3)", state);
  assert.equal(state.vfs && driver.run("get C4", state).stdout, "C4 = 3600   [formula: =SUM(B2:B3)]");

  driver.run("set A5 Office supplies", state);
  driver.run("set B5 250", state);
  driver.run("formula C5 =B5*1.2", state);
  assert.match(driver.run("get C5", state).stdout ?? "", /300/);

  driver.run("format B2:B5 currency", state);
  const sheet = (state.office.docs["Q3 Budget.xlsx"] as { sheets: { cells: Record<string, { style?: { format?: string } }> }[] }).sheets[0];
  assert.equal(sheet.cells.B2.style?.format, "currency");

  driver.run("fill B6:B8 0", state);
  assert.equal(driver.run("get B8", state).stdout, "B8 = 0");
});

test("office: document editing", () => {
  const state = createInitialState({
    ...OFFICE_SCENARIO,
    docs: [
      {
        type: "document",
        name: "Policy.docx",
        location: "/Documents/Policy.docx",
        cursor: 0,
        blocks: [
          { kind: "heading", text: "Password Policy", level: 1 },
          { kind: "paragraph", text: "Passwords must be 6 characters." },
        ],
      },
    ],
  });
  const driver = createDriver("office", { user: "student" });

  driver.run("open Policy.docx", state);
  driver.run("replace 6 characters 14 characters", state);
  const doc = state.office.docs["Policy.docx"] as { blocks: { text?: string }[] };
  assert.match(doc.blocks[1].text ?? "", /14 characters/);

  driver.run("heading 1 Review schedule", state);
  driver.run("bullet Reviewed every 90 days", state);
  driver.run("append Escalate to the security team.", state);

  const shape = driver.run("show", state).stdout ?? "";
  assert.match(shape, /# Review schedule/);
  assert.match(shape, /• Reviewed every 90 days/);
  assert.match(shape, /Escalate to the security team/);

  driver.run("insert 1 Owner: IT Operations", state);
  assert.equal(driver.run("show", state).stdout?.includes("Owner: IT Operations"), true);
});

test("office: mail workflow", () => {
  const state = createInitialState(OFFICE_SCENARIO);
  const driver = createDriver("office", { user: "student" });

  driver.run("open Inbox", state);
  assert.match(driver.run("mail list", state).stdout ?? "", /Q3 budget figures/);
  assert.match(driver.run("mail read M1001", state).stdout ?? "", /total looks wrong/);
  assert.match(driver.run("mail list", state).stdout ?? "", /Q3 budget figures/);

  driver.run('mail reply M1001 body="Confirmed: the figure was stale, now 3,600."', state);
  const mail = state.office.docs.Inbox as { messages: { folder: string; to: string[]; subject: string }[] };
  const sent = mail.messages.find((message) => message.folder === "sent");
  assert.ok(sent, "a reply should land in Sent");
  assert.match(sent.subject, /^RE: /);

  driver.run("mail flag M1001", state);
  const original = (state.office.docs.Inbox as { messages: { id: string; flagged: boolean }[] }).messages.find((m) => m.id === "M1001");
  assert.equal(original?.flagged, true);
});

/* -------------------------------------------------------------------------- */
/*  Case notes                                                                */
/* -------------------------------------------------------------------------- */

// `note_matches` reads `machine.notes`, so every console the platform ships has
// to be able to write one — otherwise a scenario that asks for a root-cause
// note can never award its point.
test("notes: every console can record a graded case note", () => {
  const linuxState = createInitialState(LINUX_SCENARIO);
  const bash = createDriver("bash", { user: "student" });
  bash.run("note Root cause: nginx was not running", linuxState);
  assert.deepEqual(linuxState.machine.notes, ["Root cause: nginx was not running"]);
  assert.match(bash.run("notes", linuxState).stdout ?? "", /Root cause: nginx/);

  const windowsState = createInitialState(WINDOWS_SCENARIO);
  const powershell = createDriver("powershell", { user: "Administrator" });
  powershell.run("note Root cause: spooler was set to Manual", windowsState);
  assert.deepEqual(windowsState.machine.notes, ["Root cause: spooler was set to Manual"]);

  const officeState = createInitialState(OFFICE_SCENARIO);
  createDriver("office", { user: "student" }).run("note Reconciled against the inventory", officeState);
  assert.deepEqual(officeState.machine.notes, ["Reconciled against the inventory"]);

  // An empty note is refused rather than silently recorded.
  const empty = bash.run("note", linuxState);
  assert.notEqual(empty.exitCode, 0);
  assert.equal(linuxState.machine.notes.length, 1);
});

// The attempt page re-renders once a second to move its countdown. The console
// must survive that: a banner that changes on every render used to tear down and
// rebuild the terminal, throwing away the half-typed command and the cursor.
test("console: the opening banner never changes mid-session", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });
  const first = driver.banner(state);

  mock.timers.enable({ apis: ["Date"] });
  try {
    mock.timers.tick(3_600_000);
    assert.equal(driver.banner(state), first, "the banner changed while the session was open");
  } finally {
    mock.timers.reset();
  }
});

/* -------------------------------------------------------------------------- */
/*  Windows administration & the desktop surface                               */
/* -------------------------------------------------------------------------- */

// The PowerShell driver refuses machine-wide changes to a standard user, so a
// scenario that has to change services, firewall rules or the registry must
// sign in as the local Administrator. Without an administrative session these
// scenarios are literally unsolvable.
test("windows: an administrative session can change machine settings", () => {
  const definition: ScenarioDefinition = {
    ...WINDOWS_SCENARIO,
    machine: { ...WINDOWS_SCENARIO.machine, user: "Administrator" },
  };
  const state = createInitialState(definition);
  const driver = createDriver("powershell", { user: "Administrator" });

  assert.equal(driver.run('Start-Service -Name "Spooler"', state).exitCode ?? 0, 0);
  assert.equal(driver.run('Set-Service -Name "Spooler" -StartupType Automatic', state).exitCode ?? 0, 0);

  const spooler = state.machine.services.find((service) => service.name === "Spooler");
  assert.equal(spooler?.active, true);
  assert.equal(spooler?.startupType, "Automatic");
});

// The session's profile has to exist, or the prompt, the file explorer and the
// desktop all open onto a directory that is not there.
test("windows: the session profile follows the signed-in account", () => {
  const state = createInitialState({
    ...WINDOWS_SCENARIO,
    machine: { ...WINDOWS_SCENARIO.machine, user: "Administrator" },
  });

  assert.equal(state.machine.cwd, "/c:/Users/Administrator");
  assert.equal(state.machine.env.USERPROFILE, "C:\\Users\\Administrator");
  assert.ok(state.vfs["/c:/users/administrator/desktop"], "the desktop folder should exist in the profile");

  // The account record has to agree with the session, or the desktop's Home
  // button walks the student out of the profile holding their files.
  const account = state.machine.users.find((user) => user.name === "Administrator");
  assert.equal(account?.home, "/c:/Users/Administrator");
});

// File Explorer's Home button opens the signed-in account's profile, which is
// exactly where a file-work ticket puts its files.
test("desktop: Home opens the profile holding the ticket's files", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);

  const account = state.machine.users.find(
    (user) => user.name.toLowerCase() === definition.machine.user.toLowerCase(),
  );
  assert.equal(account?.home, state.machine.cwd);
  assert.ok(
    state.vfs[toKey("WINDOWS", `${account?.home}/Desktop/assistant.ini`)],
    "Home should be the profile the ticket's files were copied into",
  );
});

test("validator: only the Windows platform offers a desktop surface", () => {
  assert.equal(validateDefinition(WINDOWS_DESKTOP_TEMPLATE).ok, true);
  assert.equal(validateDefinition(WINDOWS_DESKTOP_FILES_TEMPLATE).ok, true);

  const wrongPlatform = validateDefinition({ ...LINUX_SCENARIO, surface: "desktop" });
  assert.equal(wrongPlatform.ok, false);
  assert.ok(wrongPlatform.issues.some((issue) => issue.field === "surface" && issue.level === "error"));
});

// The desktop is only a view: every button sends the cmdlet a technician would
// have typed. This runs those exact command lines and grades the result, so a
// GUI change that silently breaks a scenario fails here rather than on a phone.
test("desktop: the Windows desktop scenario is solvable from its own buttons", () => {
  const definition = WINDOWS_DESKTOP_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("powershell", { user: definition.machine.user });

  // The Settings app reads this, so it has to start out blocked.
  assert.equal(updatesPaused(state), true, "the scenario should start with updates blocked");

  const clicked: string[] = [
    // Services → Start the Print Spooler, then set the startup type.
    desktopCommands.startService("Spooler"),
    desktopCommands.setStartupType("Spooler", "Automatic"),
    // Windows Update → Receive updates.
    desktopCommands.setUpdatePolicy(0),
    // Windows Security → Block the inbound RDP rule.
    desktopCommands.setFirewallAction("Allow-RDP-TCP-In", "Block"),
    // Case Notes → Save note.
    desktopCommands.recordNote("Handover: spooler restarted, update policy cleared, inbound RDP blocked."),
  ];

  for (const command of clicked) {
    const result = driver.run(command, state);
    assert.equal(result.exitCode ?? 0, 0, `the desktop would report an error for: ${command}`);
  }

  assert.equal(updatesPaused(state), false, "clearing the policy should let updates run");

  const report = gradeAttempt(definition, state);
  assert.equal(report.score, report.maxScore);
});

// File Explorer's buttons and the runner's editor are the two halves of the
// file-work surface. This runs the exact commands the buttons send and then
// saves through the same helper `saveEditor` uses, so a change to either half
// that breaks the lesson fails here.
test("desktop: the file-work scenario is solvable by clicking", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("powershell", { user: definition.machine.user });

  const desktop = "/c:/Users/Administrator/Desktop";
  const agentFile = `${desktop}/agent.ini`;

  const clicked: string[] = [
    // File Explorer → select assistant.ini → Rename.
    desktopCommands.renameItem(`${desktop}/assistant.ini`, "agent.ini"),
    // File Explorer → New folder, then open it → New file.
    desktopCommands.newFolder(`${desktop}/Deploy`),
    desktopCommands.newFile(`${desktop}/Deploy/kiosk.ini`),
    // File Explorer → select ticket-6231.txt → Cut, open Deploy → Paste.
    desktopCommands.moveItem(`${desktop}/ticket-6231.txt`, `${desktop}/Deploy`),
    // Case Notes → Save note.
    desktopCommands.recordNote("Renamed assistant.ini to agent.ini, staged Deploy and set Mode=managed."),
  ];

  for (const command of clicked) {
    const result = driver.run(command, state);
    assert.equal(result.exitCode ?? 0, 0, `the desktop would report an error for: ${command}`);
  }

  // Opening agent.ini and saving it runs `saveEditor`, which hands the buffer
  // to this exact helper. The display path is what `openEntry` would pass.
  const edited = (state.vfs[toKey("WINDOWS", agentFile)]?.content ?? "").replace(/Mode=attended/, "Mode=managed");
  writeEditedFile("WINDOWS", state.vfs, display("WINDOWS", agentFile), edited, definition.machine.user);

  const report = gradeAttempt(definition, state);
  assert.equal(
    report.score,
    report.maxScore,
    report.results.map((result) => `${result.checkId}=${result.passed}`).join(", "),
  );
});

/* -------------------------------------------------------------------------- */
/*  The desktop's pure view helpers                                           */
/* -------------------------------------------------------------------------- */

// The inline name box is the one place a student's typing becomes a command.
// These are the strings the box sends, checked without a DOM.
test("desktop: the File Explorer name box sends the expected cmdlet", () => {
  const location = { folder: "/c:/Users/Administrator/Desktop", selected: null as string | null };

  assert.equal(
    nameDraftCommand({ mode: "folder", value: "Deploy" }, location),
    'New-Item -ItemType Directory -Path "C:\\Users\\Administrator\\Desktop\\Deploy"',
  );
  assert.equal(
    nameDraftCommand({ mode: "file", value: "kiosk.ini" }, location),
    'New-Item -ItemType File -Path "C:\\Users\\Administrator\\Desktop\\kiosk.ini"',
  );
  assert.equal(
    nameDraftCommand(
      { mode: "rename", value: "agent.ini" },
      { ...location, selected: "/c:/Users/Administrator/Desktop/assistant.ini" },
    ),
    'Rename-Item -Path "C:\\Users\\Administrator\\Desktop\\assistant.ini" -NewName "agent.ini"',
  );

  // Names are trimmed, and Windows refuses separators inside a name.
  assert.equal(sanitizeName("  agent.ini  "), "agent.ini");
  assert.equal(sanitizeName("..\\evil/name.txt"), "..evilname.txt");

  // Nothing useful typed, or nothing selected, means nothing should run.
  assert.equal(nameDraftCommand({ mode: "file", value: "   " }, location), null);
  assert.equal(nameDraftCommand({ mode: "folder", value: "//" }, location), null);
  assert.equal(nameDraftCommand({ mode: "rename", value: "agent.ini" }, location), null);
});

// Drag and resize are pixels only — but a window that escapes the wallpaper or
// collapses to nothing is the sort of bug a browser check would otherwise catch.
test("desktop: window drag and resize stay inside the wallpaper", () => {
  const bounds = { w: 800, h: 600 };
  const opened = initialFrameBox(bounds);
  assert.deepEqual(opened, { x: 16, y: 16, w: 768, h: 568 });

  // A tiny wallpaper still gets a usable window rather than a negative one.
  assert.deepEqual(initialFrameBox({ w: 100, h: 100 }), { x: 16, y: 16, w: 240, h: 200 });

  const box = { x: 16, y: 16, w: 300, h: 200 };
  assert.deepEqual(moveFrame(box, 100, 50, bounds), { x: 116, y: 66, w: 300, h: 200 });
  // Dragged past every edge, it stops flush against them...
  assert.deepEqual(moveFrame(box, 10_000, 10_000, bounds), { x: 500, y: 400, w: 300, h: 200 });
  assert.deepEqual(moveFrame(box, -10_000, -10_000, bounds), { x: 0, y: 0, w: 300, h: 200 });
  // ...and a window wider than the wallpaper does not slide off to the left.
  assert.equal(moveFrame({ ...box, w: 1000 }, 0, 0, bounds).x, 0);

  assert.deepEqual(resizeFrame(box, 50, 40, bounds), { x: 16, y: 16, w: 350, h: 240 });
  // Never smaller than the minimum...
  assert.deepEqual(resizeFrame(box, -10_000, -10_000, bounds), {
    x: 16,
    y: 16,
    w: FRAME_MIN_WIDTH,
    h: FRAME_MIN_HEIGHT,
  });
  // ...and never past the wallpaper's right and bottom edges.
  assert.deepEqual(resizeFrame(box, 10_000, 10_000, bounds), { x: 16, y: 16, w: 784, h: 584 });
});

// Cut/Paste goes through `Move-Item`, so the file has to end up in the new
// folder and be gone from the old one — a bug that copies instead of moving is
// visible in a `file_absent` check.
test("desktop: Cut/Paste moves a file between folders", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("powershell", { user: definition.machine.user });

  const desktop = "/c:/Users/Administrator/Desktop";
  const ticket = `${desktop}/ticket-6231.txt`;
  const before = state.vfs[toKey("WINDOWS", ticket)]?.content ?? "";
  assert.ok(before.length > 0, "the ticket note should start on the desktop");

  // New folder first, then cut the note and paste it into the folder.
  driver.run(desktopCommands.newFolder(`${desktop}/Deploy`), state);
  const result = driver.run(desktopCommands.moveItem(ticket, `${desktop}/Deploy`), state);

  assert.equal(result.exitCode ?? 0, 0, result.stderr);
  assert.equal(state.vfs[toKey("WINDOWS", ticket)], undefined, "the note should not be left behind");
  assert.equal(
    state.vfs[toKey("WINDOWS", `${desktop}/Deploy/ticket-6231.txt`)]?.content,
    before,
    "the moved file should keep its contents",
  );
});

// Pasting an item back into the folder it came from is the one click that could
// destroy it: the old copy/remove path moved a file onto itself and deleted it.
test("desktop: pasting into the source folder is harmless", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("powershell", { user: definition.machine.user });

  const desktop = "/c:/Users/Administrator/Desktop";
  const ticket = `${desktop}/ticket-6231.txt`;
  const before = state.vfs[toKey("WINDOWS", ticket)]?.content;

  assert.equal(driver.run(desktopCommands.moveItem(ticket, desktop), state).exitCode ?? 0, 0);
  assert.equal(state.vfs[toKey("WINDOWS", ticket)]?.content, before);

  // Renaming an item to the name it already has is the same no-op.
  assert.equal(
    driver.run(desktopCommands.renameItem(ticket, baseName(ticket)), state).exitCode ?? 0,
    0,
  );
  assert.equal(state.vfs[toKey("WINDOWS", ticket)]?.content, before);
});

// What File Explorer's Paste button offers is driven by where the cut item came
// from, which is the same `dirName` the pane compares against.
test("desktop: a cut item knows which folder it came from", () => {
  const ticket = "/c:/Users/Administrator/Desktop/ticket-6231.txt";
  const deploy = "/c:/Users/Administrator/Desktop/Deploy";
  assert.equal(dirName("WINDOWS", ticket), "/c:/Users/Administrator/Desktop");
  assert.equal(baseName(ticket), "ticket-6231.txt");
  assert.equal(desktopCommands.moveItem(ticket, deploy).includes("Move-Item"), true);
});

// The editor creates a file when it is pointed at a path that does not exist
// yet — that is how a scenario asks for a fresh config or note.
test("editor: saving a buffer creates a file and updates one in place", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  const fresh = "/c:/Users/Administrator/Desktop/notes.txt";

  const created = writeEditedFile("WINDOWS", state.vfs, "C:\\Users\\Administrator\\Desktop\\notes.txt", "staged\n", "Administrator");
  assert.equal(created.path, "/c:/Users/Administrator/Desktop/notes.txt", "the path should be canonicalised");
  assert.equal(created.size, 7);
  assert.equal(state.vfs[toKey("WINDOWS", fresh)]?.content, "staged\n");

  // Re-saving keeps the original mode rather than resetting it.
  const existing = "/c:/Users/Administrator/Desktop/ticket-6231.txt";
  state.vfs[toKey("WINDOWS", existing)].mode = 0o600;
  const updated = writeEditedFile("WINDOWS", state.vfs, "C:\\Users\\Administrator\\Desktop\\ticket-6231.txt", "edited", "Administrator");
  assert.equal(updated.content, "edited");
  assert.equal(updated.size, 6);
  assert.equal(updated.mode, 0o600);
});

test("grading: a note recorded on the shell satisfies note_matches", () => {
  const definition: ScenarioDefinition = {
    ...LINUX_SCENARIO,
    checks: [{ id: "note", label: "Recorded a root-cause note", kind: "note_matches", pattern: "nginx", points: 2 }],
  };

  const state = createInitialState(definition);
  const driver = createDriver("bash", { user: "student" });

  assert.equal(gradeAttempt(definition, state).score, 0);
  driver.run("note Root cause: nginx was down", state);
  assert.equal(gradeAttempt(definition, state).score, 2);
});

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

test("grading: linux scenario scores the work that was done", () => {
  const state = createInitialState(LINUX_SCENARIO);
  const driver = createDriver("bash", { user: "student" });

  const before = gradeAttempt(LINUX_SCENARIO, state);
  assert.equal(before.score, 0);
  assert.equal(before.maxScore, 6);
  assert.equal(before.passed, false);

  driver.run("cat README", state);
  driver.run("sudo systemctl enable --now nginx", state);
  driver.run("sudo ufw allow 80/tcp", state);

  const after = gradeAttempt(LINUX_SCENARIO, state);
  assert.equal(after.score, 6, `expected full marks, got ${after.score}: ${after.results.map((r) => `${r.checkId}=${r.passed}`).join(", ")}`);
  assert.equal(after.percent, 100);
  assert.equal(after.passed, true);
});

test("grading: windows scenario is partial when half the work is done", () => {
  const state = createInitialState(WINDOWS_SCENARIO);
  const driver = createDriver("powershell", { user: "student" });

  driver.run("Start-Service Spooler", state);
  driver.run("Set-Service -Name Spooler -StartupType Automatic", state);

  const report = gradeAttempt(WINDOWS_SCENARIO, state);
  assert.equal(report.results.find((r) => r.checkId === "spooler")?.passed, true);
  assert.equal(report.results.find((r) => r.checkId === "rdp")?.passed, false);
  assert.ok(report.score > 0 && report.score < report.maxScore);
  assert.match(report.results.find((r) => r.checkId === "rdp")?.detail ?? "", /Allow-RDP-TCP-In/);
});

test("grading: office scenario and hint penalties", () => {
  const state = createInitialState(OFFICE_SCENARIO);
  const driver = createDriver("office", { user: "student" });

  driver.run("open Q3 Budget.xlsx", state);
  driver.run("formula C4 =SUM(B2:B3)", state);
  driver.run("open Inbox", state);
  driver.run('mail reply M1001 body="Corrected."', state);

  const report = gradeAttempt(OFFICE_SCENARIO, state);
  assert.equal(report.score, report.maxScore);
  assert.equal(report.percent, 100);

  // Spending a hint reduces the score without changing the maximum.
  state.meta.hintsUsed.push("hint-1");
  const penalised = gradeAttempt(
    { ...OFFICE_SCENARIO, hints: [{ id: "hint-1", text: "Use the SUM function.", penalty: 2 }] },
    state,
  );
  assert.equal(penalised.penalty, 2);
  assert.equal(penalised.score, report.score - 2);
});

test("grading: file mode and content checks respect the raw state", () => {
  const def: ScenarioDefinition = {
    version: 1,
    platform: "LINUX",
    engine: "bash",
    objective: "Harden the SSH configuration.",
    brief: "Disable password authentication and tighten the key file permissions.",
    tasks: ["Turn off password auth", "Lock down the private key"],
    machine: { hostname: "server01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
    checks: [
      { id: "passauth", label: "Password auth disabled", kind: "file_contains", path: "/etc/ssh/sshd_config", pattern: "^PasswordAuthentication\\s+no", flags: "m", points: 2 },
      { id: "keymode", label: "Key is 0600", kind: "file_mode", path: "/home/student/.ssh/id_rsa", mode: "600", points: 2 },
    ],
  };

  const state = createInitialState(def);
  const driver = createDriver("bash", { user: "student" });
  driver.run("echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config", state);
  driver.run("ssh-keygen -t ed25519 -f ~/.ssh/id_rsa", state);

  const report = gradeAttempt(def, state);
  assert.equal(report.score, 4, report.results.map((r) => `${r.checkId}:${r.detail}`).join(" | "));
});

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

test("validator: accepts the bundled scenarios", () => {
  for (const scenario of [LINUX_SCENARIO, WINDOWS_SCENARIO, OFFICE_SCENARIO]) {
    const result = validateDefinition(scenario);
    assert.equal(result.ok, true, `${scenario.platform}: ${result.issues.map((i) => i.message).join("; ")}`);
    assert.ok(result.totalPoints > 0);
  }
});

test("validator: reports precise problems", () => {
  const broken = {
    ...LINUX_SCENARIO,
    checks: [
      { id: "dup", label: "one", kind: "file_exists", path: "/tmp/a" },
      { id: "dup", label: "two", kind: "file_exists", path: "/tmp/b" },
      { id: "bad-kind", label: "typo", kind: "file_exist", path: "/tmp/c" },
      { id: "no-path", label: "missing field", kind: "file_exists" },
      { id: "bad-regex", label: "bad regex", kind: "file_contains", path: "/tmp/d", pattern: "([unclosed" },
    ],
  };

  const result = validateDefinition(broken);
  assert.equal(result.ok, false);
  const messages = result.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /Duplicate check id "dup"/);
  assert.match(messages, /Unknown check kind "file_exist"/);
  assert.match(messages, /need the `path` field/);
  assert.match(messages, /not a valid regular expression/);
});

test("validator: warns when a check passes before any work", () => {
  const result = validateDefinition({
    ...LINUX_SCENARIO,
    checks: [{ id: "trivially-true", label: "ssh is configured", kind: "service_state", name: "ssh", active: true }],
  });
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((issue) => issue.level === "warning" && /already passes/.test(issue.message)));
});

test("validator: rejects a mismatched engine", () => {
  const result = validateDefinition({ ...LINUX_SCENARIO, engine: "powershell" });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /expects the "bash" engine/.test(issue.message)));
});

/* -------------------------------------------------------------------------- */
/*  Template gallery                                                          */
/* -------------------------------------------------------------------------- */

// Every starter the authoring screen offers has to be runnable as-is: it must
// validate without errors, be worth points, and none of its checks may already
// pass on the untouched starting state (that is almost always an authoring bug).
test("templates: every gallery starter validates cleanly", () => {
  for (const entry of TEMPLATE_CHOICES) {
    const result = validateDefinition(entry.definition);
    const errors = result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
    assert.equal(result.ok, true, `${entry.key}: ${errors.join("; ")}`);
    assert.ok(result.totalPoints > 0, `${entry.key} should be worth at least one point`);
    const premature = result.issues.filter((issue) => issue.level === "warning" && /already passes/.test(issue.message));
    assert.equal(
      premature.length,
      0,
      `${entry.key}: a check passes before any work: ${premature.map((issue) => issue.message).join("; ")}`,
    );
  }
});

// `file_not_contains` is what makes "remove the stale entry" gradeable. It must
// fail while the pattern is present and pass once it is gone.
test("grader: file_not_contains passes only once the pattern is gone", () => {
  const definition: ScenarioDefinition = {
    ...LINUX_NETWORK_TEMPLATE,
    checks: [
      {
        id: "clean",
        label: "The retired resolver is gone",
        kind: "file_not_contains",
        path: "/etc/resolv.conf",
        pattern: "192\\.0\\.2\\.5",
        points: 1,
      },
    ],
  };
  const state = createInitialState(definition);
  assert.equal(gradeAttempt(definition, state).score, 0, "the stale address should fail the check to begin with");

  const driver = createDriver("bash", { user: "student" });
  driver.run('echo "nameserver 10.10.10.1" | sudo tee /etc/resolv.conf', state);
  assert.equal(gradeAttempt(definition, state).score, 1, "removing the stale address should satisfy the check");
});

/* -------------------------------------------------------------------------- */
/*  Definition isolation                                                      */
/* -------------------------------------------------------------------------- */

// Every attempt of a scenario shares one definition object, and the driver
// mutates the booted state in place. If the boot aliased `def.state` or
// `def.docs`, one attempt would silently rewrite the starting conditions for
// every later attempt (and for the validator's dry run). This pins the deep
// clone in `createInitialState`.
test("state: booting a scenario never writes back to its definition", () => {
  const definition: ScenarioDefinition = {
    ...LINUX_SCENARIO,
    state: {
      services: [{ name: "nginx", displayName: "nginx", active: false, enabled: false }],
      packages: [{ name: "curl", version: "8.5.0-2ubuntu10", installed: false }],
    },
  };

  const bash = () => createDriver("bash", { user: "student" });
  const first = createInitialState(definition);
  bash().run("sudo systemctl start nginx", first);
  bash().run("sudo apt-get install -y curl", first);
  assert.equal(first.machine.services.find((s) => s.name === "nginx")?.active, true);
  assert.equal(first.machine.packages.find((p) => p.name === "curl")?.installed, true);

  // The definition itself is untouched...
  assert.equal(definition.state?.services?.[0].active, false, "booting mutated the definition's services");
  assert.equal(definition.state?.packages?.[0].installed, false, "booting mutated the definition's packages");

  // ...and a second attempt starts from the definition, not from the first attempt.
  const second = createInitialState(definition);
  assert.equal(second.machine.services.find((s) => s.name === "nginx")?.active, false);
  assert.equal(second.machine.packages.find((p) => p.name === "curl")?.installed, false);

  // Office documents are edited in place as well, so their clone has to be just
  // as deep: writing a cell must not reach back into the shipped document.
  const officeDefinition: ScenarioDefinition = {
    ...OFFICE_SCENARIO,
    docs: OFFICE_SCENARIO.docs?.map((doc) => structuredClone(doc)),
  };
  const office = createInitialState(officeDefinition);
  createDriver("office", { user: "student" }).run("open Q3 Budget.xlsx", office);
  createDriver("office", { user: "student" }).run("set B2 9999", office);

  const sourceSheet = (officeDefinition.docs?.[0] as { sheets: { cells: Record<string, { v?: string }> }[] }).sheets[0];
  assert.equal(sourceSheet.cells.B2.v, "1200", "editing a document mutated the definition");
});

// The documented fix must actually earn full marks, so a template can never
// drift away from the commands its hints tell the student to run.
test("templates: the networking starter is solvable and worth full marks", () => {
  const definition = LINUX_NETWORK_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("bash", { user: definition.machine.user });

  driver.run('echo "nameserver 10.10.10.1" | sudo tee /etc/resolv.conf', state);
  driver.run("dig db-01.ontrak.local", state);
  driver.run("note Pointed the resolver at 10.10.10.1; DNS restored.", state);

  const report = gradeAttempt(definition, state);
  assert.equal(report.percent, 100, report.results.map((r) => `${r.checkId}:${r.detail}`).join(" | "));
});

test("templates: the accounts starters are solvable with their documented commands", () => {
  const linux = LINUX_ACCOUNTS_TEMPLATE;
  const linuxState = createInitialState(linux);
  const linuxDriver = createDriver("bash", { user: linux.machine.user });
  linuxDriver.run("sudo useradd -m jrivera", linuxState);
  linuxDriver.run("sudo usermod -aG developers jrivera", linuxState);
  linuxDriver.run("sudo userdel ksec", linuxState);
  linuxDriver.run("note Onboarded jrivera into developers; removed ksec.", linuxState);
  const linuxReport = gradeAttempt(linux, linuxState);
  assert.equal(linuxReport.percent, 100, linuxReport.results.map((r) => `${r.checkId}:${r.detail}`).join(" | "));

  const windows = WINDOWS_ACCOUNTS_TEMPLATE;
  const windowsState = createInitialState(windows);
  const windowsDriver = createDriver("powershell", { user: windows.machine.user });
  windowsDriver.run("New-LocalUser -Name kiosk02", windowsState);
  windowsDriver.run('Add-LocalGroupMember -Group "Remote Desktop Users" -Member kiosk02', windowsState);
  windowsDriver.run("Remove-LocalUser -Name oldtech", windowsState);
  windowsDriver.run("New-Item -ItemType Directory -Path C:\\ProgramData\\Kiosk", windowsState);
  windowsDriver.run("New-SmbShare -Name Kiosk -Path C:\\ProgramData\\Kiosk", windowsState);
  windowsDriver.run("note Provisioned kiosk02; removed oldtech; published the Kiosk share.", windowsState);
  const windowsReport = gradeAttempt(windows, windowsState);
  assert.equal(windowsReport.percent, 100, windowsReport.results.map((r) => `${r.checkId}:${r.detail}`).join(" | "));
});

test("templates: the service-desk triage starter is solvable", () => {
  const definition = OFFICE_TRIAGE_TEMPLATE;
  const state = createInitialState(definition);
  const driver = createDriver("office", { user: definition.machine.user });

  driver.run("mail flag M2001", state);
  driver.run('mail reply M2001 body="Acknowledged, monitoring the rollback."', state);
  driver.run('mail reply M2002 body="A technician will check the toner today."', state);
  driver.run("open Handover.docx", state);
  driver.run("append Handled the M2001 outage and logged the printer ticket.", state);
  // Mail commands act on the open document, so switch back to the mailbox first.
  driver.run("open Inbox", state);
  driver.run('mail send to=it-team@ontrak.local subject="Shift handover" body="Outage flagged and printer ticket logged."', state);

  const report = gradeAttempt(definition, state);
  assert.equal(report.percent, 100, report.results.map((r) => `${r.checkId}:${r.detail}`).join(" | "));
});
