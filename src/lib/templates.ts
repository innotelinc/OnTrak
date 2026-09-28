import type { Platform, ScenarioDefinition } from "./sim/types";

/**
 * Starter scenarios.
 *
 * Each one is a complete, runnable definition that passes validation and boots
 * in the simulator.  Instructors start from these rather than a blank page —
 * copy, change the checks, publish.
 */

export const LINUX_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Raise the internal wiki back to a healthy state.",
  brief: `# Ticket 4471 — internal wiki is down

The intranet wiki (nginx on this box) is not answering. The on-call engineer
noted that nginx is installed but the service is not running.

## What good looks like
- nginx is running and will come back after a reboot
- the firewall allows HTTP so staff can reach it
- you have recorded a short root-cause note`,
  tasks: ["Start nginx", "Enable nginx at boot", "Allow HTTP through the firewall", "Record a root-cause note"],
  machine: {
    hostname: "wiki01",
    user: "student",
    os: "Ubuntu 24.04.2 LTS",
    version: "24.04",
    kernel: "6.8.0-45-generic",
    arch: "x86_64",
  },
  files: [
    {
      path: "/home/student/README.txt",
      content:
        "Ticket 4471\n----------\nThe wiki stopped responding after the last maintenance window.\nnginx is installed. Check the service state first.\n",
    },
    { path: "/var/log/nginx/error.log", content: "2026/03/11 09:14:02 [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\n" },
  ],
  checks: [
    { id: "svc-running", label: "nginx is running", kind: "service_state", name: "nginx", active: true, points: 2 },
    { id: "svc-enabled", label: "nginx survives a reboot", kind: "service_state", name: "nginx", enabled: true, points: 2 },
    { id: "fw-open", label: "HTTP is allowed through the firewall", kind: "firewall_rule", name: "allow-80", action: "allow", points: 2 },
    { id: "checked-logs", label: "Checked the service state before changing anything", kind: "command_sequence", patterns: ["systemctl (status|is-active)", "(journalctl|tail .*error\\.log)"], points: 1 },
    { id: "note", label: "Recorded a root-cause note", kind: "note_matches", pattern: "nginx", points: 1 },
  ],
  hints: [
    { id: "hint-svc", text: "`systemctl status nginx` tells you whether the unit is active and/or enabled.", penalty: 1 },
    { id: "hint-fw", text: "Opening a port with ufw needs root: `sudo ufw allow 80/tcp`.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes: "Good first Linux scenario: one service, one firewall rule, one note.",
};

export const WINDOWS_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  objective: "Restore printing and close down an unnecessary remote-access path.",
  brief: `# Ticket 5208 — nobody can print, and RDP is exposed

Two jobs, both from the same security review.

1. The print spooler was switched to a manual start and has been stopping
   overnight. Put it back the way it should be.
2. Inbound Remote Desktop is open on this machine. Close it and record what
   you changed.`,
  tasks: ["Start the Spooler service", "Set the Spooler to start automatically", "Block inbound RDP", "Record a note"],
  machine: {
    hostname: "WS-014",
    // Every task here changes a machine-wide setting, and the PowerShell driver
    // refuses those for a standard user — so the scenario signs the student in
    // as the local Administrator, exactly as a help-desk technician would.
    user: "Administrator",
    os: "Microsoft Windows 11 Pro",
    version: "10.0.22631",
    build: "22631.3155",
    arch: "64-bit",
  },
  files: [
    {
      path: "C:\\Users\\student\\Desktop\\ticket.txt",
      content: "Ticket 5208\r\nThe spooler keeps stopping. Also: security want RDP closed.\r\n",
    },
  ],
  state: {
    // Declaring services replaces the platform defaults, which is how the
    // scenario starts in the broken state the ticket describes.
    services: [
      {
        name: "Spooler",
        displayName: "Print Spooler",
        description: "Loads files to memory for later printing",
        active: false,
        enabled: false,
        startupType: "Manual",
      },
      {
        name: "W32Time",
        displayName: "Windows Time",
        description: "Maintains date and time synchronization",
        active: true,
        enabled: true,
        startupType: "Manual",
      },
      {
        name: "LanmanServer",
        displayName: "Server",
        description: "Supports file, print and named-pipe sharing",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
      {
        name: "WinDefend",
        displayName: "Microsoft Defender Antivirus Service",
        description: "Helps protect users from malware",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
      {
        name: "TermService",
        displayName: "Remote Desktop Services",
        description: "Allows users to connect interactively to a remote computer",
        active: false,
        enabled: false,
        startupType: "Manual",
      },
    ],
  },
  checks: [
    { id: "spooler-up", label: "Spooler is running", kind: "service_state", name: "Spooler", active: true, points: 2 },
    {
      id: "spooler-auto",
      label: "Spooler starts automatically",
      kind: "service_state",
      name: "Spooler",
      enabled: true,
      points: 2,
    },
    { id: "rdp-closed", label: "Inbound RDP is blocked", kind: "firewall_rule", name: "Allow-RDP-TCP-In", action: "deny", points: 3 },
    {
      id: "note",
      label: "Recorded what changed",
      kind: "note_matches",
      pattern: "spooler|rdp|remote desktop",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-spooler", text: "`Get-Service Spooler` first, then `Start-Service` and `Set-Service -StartupType Automatic`.", penalty: 1 },
    { id: "hint-fw", text: "`Get-NetFirewallRule -DisplayName \"Allow-RDP-TCP-In\"` shows the rule; use `Set-NetFirewallRule -Action Block` to close it.", penalty: 2 },
  ],
  allowHints: true,
  authorNotes: "Teaches service startup types and firewall rule verbs.",
};

/**
 * The graphical Windows desktop.
 *
 * Same machine, same driver, same grader as `WINDOWS_TEMPLATE` — the difference
 * is that the student works in windows instead of a shell. Everything the
 * checks look at can be done by clicking, and the Terminal tab is still there
 * for anyone who would rather type the cmdlets.
 */
export const WINDOWS_DESKTOP_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  surface: "desktop",
  objective: "Recommission the reception PC before it goes back to the front desk.",
  brief: `# Ticket 6104 — reception PC, recommission before handover

The reception machine came back from a rebuild and the site manager needs it on
desk tomorrow. Work it the way you would at the desk: open the apps, fix what is
wrong, and leave a handover note.

- Printing is dead: the spooler was left stopped and disabled.
- Updates are stuck on a leftover “pause updates” policy from the rebuild.
- Inbound Remote Desktop is still open from the imaging team.

Click, or open the Terminal tab and type the cmdlets — both count.`,
  tasks: [
    "Start the Print Spooler and set it to start automatically",
    "Clear the policy that is blocking Windows Update",
    "Block inbound Remote Desktop",
    "Leave a handover note",
  ],
  machine: {
    hostname: "RECEPTION-01",
    user: "Administrator",
    os: "Microsoft Windows 11 Pro",
    version: "10.0.22631",
    build: "22631.3155",
    arch: "64-bit",
  },
  files: [
    {
      path: "C:\\Users\\Administrator\\Desktop\\handover.txt",
      content:
        "Ticket 6104\r\n-----------\r\nRebuilt last week. Printing failed the smoke test, updates are\r\npaused by policy and security flagged RDP still listening.\r\n",
    },
    {
      path: "C:\\Users\\Administrator\\Documents\\print-queue.log",
      content:
        "2026-03-11 08:41:02 Spooler service entered the stopped state (startup type Disabled)\r\n2026-03-11 08:41:02 Print job 214 failed\r\n",
    },
  ],
  state: {
    services: [
      {
        name: "Spooler",
        displayName: "Print Spooler",
        description: "Loads files to memory for later printing",
        active: false,
        enabled: false,
        startupType: "Disabled",
      },
      {
        name: "W32Time",
        displayName: "Windows Time",
        description: "Maintains date and time synchronization",
        active: true,
        enabled: true,
        startupType: "Manual",
      },
      {
        name: "LanmanServer",
        displayName: "Server",
        description: "Supports file, print and named-pipe sharing",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
      {
        name: "WinDefend",
        displayName: "Microsoft Defender Antivirus Service",
        description: "Helps protect users from malware",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
      {
        name: "TermService",
        displayName: "Remote Desktop Services",
        description: "Allows users to connect interactively to a remote computer",
        active: false,
        enabled: false,
        startupType: "Manual",
      },
    ],
    registry: [
      {
        path: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate",
        name: "NoAutoUpdate",
        type: "DWord",
        value: 1,
      },
    ],
    firewall: [
      { name: "Allow-RDP-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "3389", enabled: true },
      { name: "Allow-HTTP-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "80", enabled: true },
      { name: "Allow-HTTPS-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "443", enabled: true },
    ],
    events: [
      {
        at: Date.now() - 5_400_000,
        source: "Service Control Manager",
        level: "error",
        id: 7036,
        message: "The Print Spooler service entered the stopped state.",
      },
      {
        at: Date.now() - 3_600_000,
        source: "GroupPolicy",
        level: "warning",
        id: 1500,
        message: "Policy NoAutoUpdate is in effect; automatic updates will not run.",
      },
      {
        at: Date.now() - 1_800_000,
        source: "Microsoft-Windows-Security-Auditing",
        level: "warning",
        id: 5156,
        message: "The Windows Filtering Platform allowed a connection on port 3389.",
      },
    ],
  },
  checks: [
    { id: "spooler-up", label: "Print Spooler is running", kind: "service_state", name: "Spooler", active: true, points: 2 },
    { id: "spooler-auto", label: "Print Spooler starts automatically", kind: "service_state", name: "Spooler", enabled: true, points: 2 },
    {
      id: "updates-on",
      label: "Updates are no longer blocked by policy",
      kind: "registry_value",
      path: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate",
      name: "NoAutoUpdate",
      equals: 0,
      points: 2,
    },
    { id: "rdp-blocked", label: "Inbound RDP is blocked", kind: "firewall_rule", name: "Allow-RDP-TCP-In", action: "deny", points: 2 },
    {
      id: "note",
      label: "Left a handover note",
      kind: "note_matches",
      pattern: "spooler|rdp|remote desktop|update",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-spooler", text: "Services lists every service: Start the Print Spooler and set its startup type to Automatic.", penalty: 1 },
    { id: "hint-updates", text: "Settings → Windows Update shows the policy that is holding updates back.", penalty: 1 },
    { id: "hint-rdp", text: "Windows Security → Firewall shows the inbound rules; the RDP rule can be blocked there.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes:
    "Desktop-surface scenario: graded entirely through the Services, Windows Update and Windows Security apps, with the note app for the write-up. Solvable from the console tab too — the surface only changes what the student sees.",
};

/**
 * Desktop surface, file work.
 *
 * Where `WINDOWS_DESKTOP_TEMPLATE` is about services and policy, this one is
 * about File Explorer: rename a leftover, create a folder and a file inside it,
 * move a file with Cut/Paste, and edit a config through the editor. Every check
 * reads the resulting filesystem, so File Explorer clicks and the matching
 * cmdlets in the Terminal tab are graded exactly the same.
 */
export const WINDOWS_DESKTOP_FILES_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  surface: "desktop",
  objective: "Stage the front-desk kiosk deployment files before the machine ships.",
  brief: `# Ticket 6231 — stage the kiosk deployment files

The front-desk kiosk goes out this afternoon and its files are not ready. Work
it from the desktop, the way you would at the machine.

- The vendor's config was copied in under the wrong name: the desktop file
  \`assistant.ini\` should be called \`agent.ini\`.
- Create a \`Deploy\` folder on the desktop and put an empty \`kiosk.ini\`
  inside it.
- Move the ticket note into \`Deploy\` too, so the kiosk ships with it: select
  \`ticket-6231.txt\`, choose Cut, open \`Deploy\` and choose Paste.
- Open \`agent.ini\` from File Explorer, set \`Mode=managed\` and save it.
- Leave a handover note.

Click, or open the Terminal tab and type the cmdlets — both count.`,
  tasks: [
    "Rename assistant.ini on the desktop to agent.ini",
    "Create a Deploy folder on the desktop",
    "Create kiosk.ini inside the Deploy folder",
    "Move ticket-6231.txt into the Deploy folder",
    "Set Mode=managed in agent.ini",
    "Leave a handover note",
  ],
  machine: {
    hostname: "KIOSK-01",
    user: "Administrator",
    os: "Microsoft Windows 11 Pro",
    version: "10.0.22631",
    build: "22631.3155",
    arch: "64-bit",
  },
  files: [
    {
      path: "C:\\Users\\Administrator\\Desktop\\assistant.ini",
      content: "[agent]\r\nServer=contoso-kiosk-01\r\nMode=attended\r\n",
    },
    {
      path: "C:\\Users\\Administrator\\Desktop\\ticket-6231.txt",
      content:
        "Ticket 6231\r\n-----------\r\nThe kiosk build needs its config renamed and a Deploy folder staged.\r\n",
    },
  ],
  state: {
    events: [
      {
        at: Date.now() - 7_200_000,
        source: "Microsoft-Windows-Shell-Core",
        level: "warning",
        id: 4101,
        message: "The vendor installer copied a file to the desktop with an unexpected name.",
      },
    ],
  },
  checks: [
    {
      id: "renamed",
      label: "assistant.ini was renamed to agent.ini",
      kind: "file_exists",
      path: "C:\\Users\\Administrator\\Desktop\\agent.ini",
      points: 2,
    },
    {
      id: "leftover-gone",
      label: "The old assistant.ini name is gone",
      kind: "file_absent",
      path: "C:\\Users\\Administrator\\Desktop\\assistant.ini",
      points: 1,
    },
    {
      id: "deploy-dir",
      label: "Deploy folder exists on the desktop",
      kind: "dir_exists",
      path: "C:\\Users\\Administrator\\Desktop\\Deploy",
      points: 2,
    },
    {
      id: "kiosk-file",
      label: "kiosk.ini was created inside Deploy",
      kind: "file_exists",
      path: "C:\\Users\\Administrator\\Desktop\\Deploy\\kiosk.ini",
      points: 2,
    },
    {
      id: "ticket-staged",
      label: "ticket-6231.txt now lives in Deploy",
      kind: "file_exists",
      path: "C:\\Users\\Administrator\\Desktop\\Deploy\\ticket-6231.txt",
      points: 2,
    },
    {
      id: "ticket-moved",
      label: "ticket-6231.txt was moved, not copied",
      kind: "file_absent",
      path: "C:\\Users\\Administrator\\Desktop\\ticket-6231.txt",
      points: 1,
    },
    {
      id: "mode-set",
      label: "agent.ini sets Mode=managed",
      kind: "file_contains",
      path: "C:\\Users\\Administrator\\Desktop\\agent.ini",
      pattern: "^Mode=managed",
      flags: "m",
      points: 2,
    },
    {
      id: "note",
      label: "Left a handover note",
      kind: "note_matches",
      pattern: "agent\\.ini|deploy|kiosk|rename",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-rename", text: "Select assistant.ini in File Explorer and press Rename, then type agent.ini.", penalty: 1 },
    { id: "hint-folder", text: "File Explorer's New folder creates Deploy; New file makes kiosk.ini inside it.", penalty: 1 },
    { id: "hint-move", text: "Select ticket-6231.txt, press Cut, open Deploy, then press Paste.", penalty: 1 },
    { id: "hint-edit", text: "Double-click agent.ini to open the editor, add Mode=managed, then save.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes:
    "Desktop-surface, file-work scenario: graded from the filesystem, so File Explorer or the New-Item / Rename-Item / Move-Item cmdlets all count. No services or policy work — the File Explorer is the point.",
};

export const OFFICE_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "OFFICE",
  engine: "office",
  objective: "Fix the quarterly budget and answer the finance director.",
  brief: `# The Q3 budget sheet is wrong

The finance director has emailed you. The Q3 total in the budget workbook has
become stale — it does not reflect the two line items above it.

- Correct the total so it sums Q3 spend.
- Make the numbers in the Q3 column display as currency.
- Reply to the director confirming the corrected figure.`,
  tasks: [
    "Correct the Q3 total formula",
    "Format the Q3 column as currency",
    "Reply to the finance director",
  ],
  machine: { hostname: "workstation", user: "student", os: "Office Productivity Suite", version: "2024", arch: "web" },
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
            A1: { v: "Item", style: { bold: true } },
            B1: { v: "Q3", style: { bold: true } },
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
          from: "finance.director@ontrak.local",
          to: ["student@ontrak.local"],
          subject: "Q3 budget figures",
          body:
            "The Q3 total in the workbook does not match the line items underneath it. Could you correct it and confirm the figure back to me?",
          at: 1_772_000_000_000,
          read: false,
          flagged: false,
          folder: "inbox",
        },
      ],
    },
  ],
  checks: [
    {
      id: "total",
      label: "Q3 total is correct",
      kind: "cell_equals",
      doc: "Q3 Budget.xlsx",
      cell: "C4",
      equals: 3600,
      points: 3,
    },
    {
      id: "formula",
      label: "The total is a formula, not a typed number",
      kind: "cell_formula_contains",
      doc: "Q3 Budget.xlsx",
      cell: "C4",
      pattern: "^SUM",
      points: 2,
    },
    {
      id: "currency",
      label: "Q3 column is formatted as currency",
      kind: "cell_style",
      doc: "Q3 Budget.xlsx",
      cell: "B2",
      format: "currency",
      points: 1,
    },
    {
      id: "reply",
      label: "Replied to the finance director",
      kind: "mail_sent",
      to: "finance.director@ontrak.local",
      subjectPattern: "Q3",
      flags: "i",
      points: 2,
    },
  ],
  hints: [
    { id: "hint-formula", text: "`formula C4 =SUM(B2:B3)` replaces the stale value with a live total.", penalty: 1 },
    { id: "hint-format", text: "`format B2:B3 currency` changes how the Q3 figures are displayed.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes: "Grade formatting with a `cell_style` check so the spreadsheet half of the ticket counts too.",
};

/**
 * Networking triage.
 *
 * A single misconfiguration — a decommissioned DNS resolver left in
 * `/etc/resolv.conf` — that stops the box resolving internal names. The fix is
 * a config edit plus a lookup to prove it, and the `file_not_contains` check
 * makes "the dead entry is gone" a first-class, gradable requirement rather
 * than a side effect.
 */
export const LINUX_NETWORK_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Restore name resolution on the app server before the deployment window.",
  brief: `# Ticket 8123 — app-01 cannot resolve internal names

The deployment pipeline failed its pre-flight check: app-01 can no longer
resolve any internal hostname. Name resolution worked before the network team
decommissioned the old resolver overnight.

## What good looks like
- /etc/resolv.conf points at the internal resolver 10.10.10.1
- the retired resolver addresses are gone from the file
- you have looked a name up to confirm resolution works
- you have recorded a short note describing the change`,
  tasks: [
    "Read the ticket",
    "Inspect the current resolver configuration",
    "Point /etc/resolv.conf at the internal resolver 10.10.10.1",
    "Remove the decommissioned resolver entries",
    "Look up an internal name to confirm resolution",
    "Record a note",
  ],
  machine: {
    hostname: "app-01",
    user: "student",
    os: "Ubuntu 24.04.2 LTS",
    version: "24.04",
    kernel: "6.8.0-45-generic",
    arch: "x86_64",
  },
  files: [
    {
      path: "/home/student/ticket-8123.txt",
      content:
        "Ticket 8123\n----------\nPre-flight failed: no DNS. The old resolver (192.0.2.53) was retired\nlast night. Point /etc/resolv.conf at the internal resolver 10.10.10.1.\n",
    },
    {
      path: "/etc/resolv.conf",
      content: "# Resolver configuration written by the network team\nnameserver 192.0.2.53\nnameserver 192.0.2.54\nsearch lab.invalid\n",
    },
  ],
  checks: [
    {
      id: "resolver-set",
      label: "The internal resolver 10.10.10.1 is configured",
      kind: "file_contains",
      path: "/etc/resolv.conf",
      pattern: "nameserver\\s+10\\.10\\.10\\.1",
      points: 3,
    },
    {
      id: "stale-resolver-gone",
      label: "The retired resolver addresses are gone",
      kind: "file_not_contains",
      path: "/etc/resolv.conf",
      pattern: "192\\.0\\.2\\.5",
      points: 2,
    },
    {
      id: "lookup",
      label: "An internal name was looked up",
      kind: "command_matched",
      pattern: "\\b(dig|nslookup|host|getent)\\b",
      points: 1,
    },
    {
      id: "note",
      label: "Recorded what changed",
      kind: "note_matches",
      pattern: "resolv|resolver|dns|10\\.10\\.10\\.1",
      flags: "i",
      points: 2,
    },
  ],
  hints: [
    { id: "hint-read", text: "cat /etc/resolv.conf shows the addresses this box is actually querying.", penalty: 1 },
    {
      id: "hint-edit",
      text: 'echo "nameserver 10.10.10.1" | sudo tee /etc/resolv.conf replaces the dead entries with one good one.',
      penalty: 2,
    },
    { id: "hint-check", text: "dig db-01.ontrak.local confirms the new resolver answers.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes:
    "Networking triage: one file edit, a proof lookup and a note. The file_not_contains check is what makes 'remove the retired addresses' gradeable.",
};

/**
 * Accounts lifecycle.
 *
 * Onboarding and offboarding in one ticket: create an account with its home
 * directory, place it in a group, and remove a contractor whose engagement has
 * ended. `state.users` seeds the contractor so the offboarding half has
 * something real to remove.
 */
export const LINUX_ACCOUNTS_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Onboard the new developer and close down the contractor's account.",
  brief: `# Ticket 3902 — onboarding and offboarding on build01

HR raised two requests in the same ticket:

1. Onboard **Jo Rivera** (username jrivera). Create the account with its home
   directory and make it a member of the developers group.
2. Offboard the contractor **ksec** — the engagement ended on Friday, so the
   account must not remain.

Finish with a short note so the change is auditable.`,
  tasks: [
    "Read the ticket",
    "Create the jrivera account with a home directory",
    "Add jrivera to the developers group",
    "Remove the contractor account ksec",
    "Record a note",
  ],
  machine: {
    hostname: "build01",
    user: "student",
    os: "Ubuntu 24.04.2 LTS",
    version: "24.04",
    kernel: "6.8.0-45-generic",
    arch: "x86_64",
  },
  files: [
    {
      path: "/home/student/ticket-3902.txt",
      content:
        "Ticket 3902\n----------\nOnboard jrivera (Jo Rivera) into the developers group with a home directory.\nOffboard contractor ksec - engagement ended Friday, account must be gone.\n",
    },
  ],
  state: {
    users: [
      { name: "root", uid: 0, gid: 0, groups: ["root"], shell: "/bin/bash", home: "/root", fullName: "root", locked: false },
      {
        name: "student",
        uid: 1000,
        gid: 1000,
        groups: ["student", "sudo", "adm"],
        shell: "/bin/bash",
        home: "/home/student",
        fullName: "Student User",
        locked: false,
      },
      {
        name: "ksec",
        uid: 1003,
        gid: 1003,
        groups: ["ksec"],
        shell: "/bin/bash",
        home: "/home/ksec",
        fullName: "K. Sec (contractor)",
        locked: false,
      },
    ],
  },
  checks: [
    { id: "user-created", label: "The jrivera account exists", kind: "user_exists", name: "jrivera", exists: true, points: 2 },
    { id: "home-dir", label: "jrivera has a home directory", kind: "dir_exists", path: "/home/jrivera", points: 2 },
    {
      id: "developers",
      label: "jrivera is in the developers group",
      kind: "user_in_group",
      name: "jrivera",
      group: "developers",
      points: 3,
    },
    {
      id: "contractor-gone",
      label: "The contractor account ksec is gone",
      kind: "user_exists",
      name: "ksec",
      exists: false,
      points: 3,
    },
    {
      id: "note",
      label: "Recorded the change",
      kind: "note_matches",
      pattern: "jrivera|ksec|developers|onboard",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-add", text: "sudo useradd -m jrivera creates the account and its home directory in one step.", penalty: 1 },
    { id: "hint-group", text: "sudo usermod -aG developers jrivera adds the group without dropping the others.", penalty: 1 },
    { id: "hint-del", text: "sudo userdel ksec removes the contractor's account.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes:
    "Accounts lifecycle: create, group membership, remove. The contractor account is seeded through state.users, so the offboarding half has something real to delete.",
};

/**
 * Endpoint account provisioning on Windows.
 *
 * The companion to the Linux accounts scenario, with the Windows verbs: create a
 * local account, place it in a group, delete a stale login, create a folder and
 * publish it as an SMB share. Everything here needs elevation, so the scenario
 * signs in as the local Administrator.
 */
export const WINDOWS_ACCOUNTS_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  objective: "Provision the kiosk account and retire the old technician's login.",
  brief: `# Ticket 4410 — kiosk provisioning on KIOSK-PC2

Front-desk kiosk #2 is being rebuilt. Do the account work and publish the shared
folder the kiosk reads its content from.

- Create a local account for the kiosk: **kiosk02**.
- Add **kiosk02** to the **Remote Desktop Users** group so support can reach it.
- The old technician's account **oldtech** is no longer used — remove it.
- Create the folder C:\\ProgramData\\Kiosk and share it as **Kiosk**.
- Record a note when you are done.`,
  tasks: [
    "Read the ticket",
    "Create the kiosk02 local account",
    "Add kiosk02 to Remote Desktop Users",
    "Remove the oldtech account",
    "Create C:\\ProgramData\\Kiosk",
    "Share it as Kiosk",
    "Record a note",
  ],
  machine: {
    hostname: "KIOSK-PC2",
    user: "Administrator",
    os: "Microsoft Windows 11 Pro",
    version: "10.0.22631",
    build: "22631.3155",
    arch: "64-bit",
  },
  files: [
    {
      path: "C:\\Users\\Administrator\\Desktop\\ticket-4410.txt",
      content:
        "Ticket 4410\r\n-----------\r\nProvision kiosk02, add it to Remote Desktop Users, delete oldtech, and\r\nshare C:\\ProgramData\\Kiosk as \"Kiosk\".\r\n",
    },
  ],
  state: {
    users: [
      {
        name: "Administrator",
        uid: 500,
        gid: 544,
        groups: ["Administrators"],
        shell: "cmd.exe",
        home: "/c:/Users/Administrator",
        passwordHash: null,
        locked: false,
        description: "Built-in account for administering the computer/domain",
        enabled: true,
      },
      {
        name: "student",
        uid: 1001,
        gid: 545,
        groups: ["Users", "Remote Desktop Users"],
        shell: "cmd.exe",
        home: "/c:/Users/student",
        passwordHash: "u",
        locked: false,
        fullName: "student on KIOSK-PC2",
        enabled: true,
      },
      {
        name: "oldtech",
        uid: 1002,
        gid: 545,
        groups: ["Administrators"],
        shell: "cmd.exe",
        home: "/c:/Users/oldtech",
        passwordHash: "u",
        locked: false,
        description: "Former technician - engagement ended",
        enabled: true,
      },
    ],
  },
  checks: [
    { id: "user-created", label: "The kiosk02 account exists", kind: "user_exists", name: "kiosk02", exists: true, points: 2 },
    {
      id: "rdp-group",
      label: "kiosk02 is in Remote Desktop Users",
      kind: "user_in_group",
      name: "kiosk02",
      group: "Remote Desktop Users",
      points: 3,
    },
    { id: "old-tech-gone", label: "The oldtech account is removed", kind: "user_exists", name: "oldtech", exists: false, points: 3 },
    { id: "dir", label: "The kiosk folder exists", kind: "dir_exists", path: "C:\\ProgramData\\Kiosk", points: 2 },
    { id: "share", label: "The Kiosk share is published", kind: "share_exists", name: "Kiosk", exists: true, points: 2 },
    {
      id: "note",
      label: "Recorded the change",
      kind: "note_matches",
      pattern: "kiosk02|oldtech|kiosk|share",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-add", text: "New-LocalUser -Name kiosk02 -NoPassword creates the account.", penalty: 1 },
    {
      id: "hint-group",
      text: 'Add-LocalGroupMember -Group "Remote Desktop Users" -Member kiosk02 places it in the group.',
      penalty: 1,
    },
    { id: "hint-del", text: "Remove-LocalUser -Name oldtech deletes the stale login.", penalty: 1 },
    { id: "hint-share", text: "New-Item -ItemType Directory -Path C:\\ProgramData\\Kiosk then New-SmbShare -Name Kiosk -Path C:\\ProgramData\\Kiosk.", penalty: 2 },
  ],
  allowHints: true,
  authorNotes:
    "Endpoint provisioning: local account, group membership, removal, folder and SMB share. Needs elevation, so the session runs as Administrator.",
};

/**
 * Service-desk basics.
 *
 * The first-line mailbox exercise: triage a production outage, acknowledge it,
 * answer a minor ticket, write the handover note and send the end-of-shift
 * summary. Nothing here is shell work — it is the reading, replying and
 * documenting that fill a service desk's day.
 */
export const OFFICE_TRIAGE_TEMPLATE: ScenarioDefinition = {
  version: 1,
  platform: "OFFICE",
  engine: "office",
  objective: "Work the first-line support mailbox: triage, reply and hand over.",
  brief: `# Shift handover — first-line support mailbox

You are covering the service desk this afternoon. Work the inbox the way the
runbook says:

- **Flag** the production outage so the on-call engineer sees it at the top.
- **Reply** to the outage reporter to acknowledge the ticket.
- **Reply** to the finance director about the floor 3 printer.
- Open Handover.docx and **append a handover note** that mentions the outage.
- Email the team a short summary at it-team@ontrak.local.`,
  tasks: [
    "Read the mailbox",
    "Flag the production outage",
    "Reply to the outage reporter",
    "Reply to the finance director about the printer",
    "Append a handover note to Handover.docx",
    "Email the team a summary",
  ],
  machine: { hostname: "servicedesk", user: "student", os: "Office Productivity Suite", version: "2024", arch: "web" },
  docs: [
    {
      type: "mail",
      name: "Inbox",
      location: "/Inbox",
      messages: [
        {
          id: "M2001",
          from: "ops.oncall@ontrak.local",
          to: ["support@ontrak.local"],
          subject: "Production outage — checkout is down",
          body:
            "Checkout has been returning 500s since 13:05 and customers cannot pay. We are rolling back now. Please acknowledge this ticket.",
          at: 1_772_000_000_000,
          read: false,
          flagged: false,
          folder: "inbox",
        },
        {
          id: "M2002",
          from: "finance.director@ontrak.local",
          to: ["support@ontrak.local"],
          subject: "Floor 3 printer out of toner",
          body: "The printer on floor 3 has been flashing a toner warning all morning. Could someone take a look?",
          at: 1_771_990_000_000,
          read: false,
          flagged: false,
          folder: "inbox",
        },
        {
          id: "M2003",
          from: "newsletter@vendor.example",
          to: ["support@ontrak.local"],
          subject: "March product newsletter",
          body: "New features, tips and a webinar invite. Not an incident.",
          at: 1_771_980_000_000,
          read: false,
          flagged: false,
          folder: "inbox",
        },
      ],
    },
    {
      type: "document",
      name: "Handover.docx",
      location: "/Documents/Handover.docx",
      cursor: 0,
      blocks: [
        { kind: "heading", text: "Shift handover", level: 1 },
        { kind: "paragraph", text: "Add your entries for this shift below." },
      ],
    },
  ],
  checks: [
    {
      id: "flag-outage",
      label: "The production outage is flagged",
      kind: "mail_flagged",
      subjectPattern: "outage",
      flags: "i",
      flagged: true,
      points: 2,
    },
    {
      id: "ack-outage",
      label: "Replied to the outage reporter",
      kind: "mail_sent",
      to: "ops.oncall@ontrak.local",
      subjectPattern: "outage",
      flags: "i",
      points: 3,
    },
    {
      id: "reply-printer",
      label: "Replied to the finance director about the printer",
      kind: "mail_sent",
      to: "finance.director@ontrak.local",
      subjectPattern: "printer",
      flags: "i",
      points: 2,
    },
    {
      id: "handover",
      label: "Appended a handover note naming the outage",
      kind: "doc_contains",
      doc: "Handover.docx",
      pattern: "outage|checkout|escalat",
      flags: "i",
      points: 3,
    },
    {
      id: "summary",
      label: "Emailed the team a summary",
      kind: "mail_sent",
      to: "it-team@ontrak.local",
      subjectPattern: "handover|summary|shift",
      flags: "i",
      points: 2,
    },
  ],
  hints: [
    { id: "hint-flag", text: "mail flag M2001 marks the outage for the on-call engineer.", penalty: 1 },
    { id: "hint-reply", text: 'mail reply M2001 body="Acknowledged, monitoring." sends the acknowledgement.', penalty: 1 },
    { id: "hint-doc", text: "open Handover.docx switches the active document, then append ... adds your note.", penalty: 2 },
    {
      id: "hint-summary",
      text: 'Mail commands act on the open document, so open Inbox first, then mail send to=it-team@ontrak.local subject="Shift handover" body="...".',
      penalty: 1,
    },
  ],
  allowHints: true,
  authorNotes:
    "Service-desk basics: mail triage and documentation rather than shell work. The handover check deliberately avoids words already present in the document so it cannot pass before the student writes anything.",
};

export const TEMPLATES: Record<Platform, ScenarioDefinition> = {
  LINUX: LINUX_TEMPLATE,
  WINDOWS: WINDOWS_TEMPLATE,
  OFFICE: OFFICE_TEMPLATE,
};

/**
 * Every starter the authoring screen offers, including the ones that share a
 * platform but present a different surface.
 */
export const TEMPLATE_CHOICES: { key: string; platform: Platform; title: string; blurb: string; definition: ScenarioDefinition }[] = [
  {
    key: "LINUX",
    platform: "LINUX",
    title: "Linux starter",
    blurb: "A ticket about a downed nginx service: systemd, ufw and a root-cause note.",
    definition: LINUX_TEMPLATE,
  },
  {
    key: "WINDOWS",
    platform: "WINDOWS",
    title: "Windows console starter",
    blurb: "Restore the print spooler and close an exposed RDP rule with PowerShell.",
    definition: WINDOWS_TEMPLATE,
  },
  {
    key: "WINDOWS_DESKTOP",
    platform: "WINDOWS",
    title: "Windows desktop starter",
    blurb: "The same sort of ticket, worked in an actual desktop: Services, Windows Update and Windows Security.",
    definition: WINDOWS_DESKTOP_TEMPLATE,
  },
  {
    key: "WINDOWS_DESKTOP_FILES",
    platform: "WINDOWS",
    title: "Windows desktop file-work starter",
    blurb: "Rename, create, move and edit files in File Explorer — graded from the filesystem.",
    definition: WINDOWS_DESKTOP_FILES_TEMPLATE,
  },
  {
    key: "LINUX_NETWORK",
    platform: "LINUX",
    title: "Linux networking starter",
    blurb: "A decommissioned DNS resolver: repair resolv.conf, prove resolution and note the fix.",
    definition: LINUX_NETWORK_TEMPLATE,
  },
  {
    key: "LINUX_ACCOUNTS",
    platform: "LINUX",
    title: "Linux accounts starter",
    blurb: "Onboard a developer, add them to a group and offboard a contractor — accounts lifecycle.",
    definition: LINUX_ACCOUNTS_TEMPLATE,
  },
  {
    key: "WINDOWS_ACCOUNTS",
    platform: "WINDOWS",
    title: "Windows endpoint starter",
    blurb: "Provision a kiosk account, retire a stale login, create a folder and publish an SMB share.",
    definition: WINDOWS_ACCOUNTS_TEMPLATE,
  },
  {
    key: "OFFICE",
    platform: "OFFICE",
    title: "Office starter",
    blurb: "Fix a stale spreadsheet total, format the column and answer the finance director.",
    definition: OFFICE_TEMPLATE,
  },
  {
    key: "OFFICE_TRIAGE",
    platform: "OFFICE",
    title: "Service-desk triage starter",
    blurb: "Work the first-line mailbox: flag an outage, reply, write the handover and email a summary.",
    definition: OFFICE_TRIAGE_TEMPLATE,
  },
];

/** A blank-ish starting point when the instructor wants to write from scratch. */
export function blankDefinition(platform: Platform): ScenarioDefinition {
  const base = TEMPLATES[platform];
  return {
    ...base,
    objective: "",
    brief: "",
    tasks: ["Describe the first thing the student must do"],
    files: [],
    docs: platform === "OFFICE" ? [] : undefined,
    checks: [
      {
        id: "replace-me",
        label: "Describe what success looks like",
        kind: platform === "OFFICE" ? "doc_contains" : platform === "WINDOWS" ? "service_state" : "file_exists",
        ...(platform === "OFFICE"
          ? { doc: "Document.docx", pattern: "todo" }
          : platform === "WINDOWS"
            ? { name: "Spooler", active: true }
            : { path: "/home/student/example.txt" }),
        points: 1,
      } as ScenarioDefinition["checks"][number],
    ],
    hints: [],
  };
}

export function serializeDefinition(definition: ScenarioDefinition): string {
  return JSON.stringify(definition, null, 2);
}
