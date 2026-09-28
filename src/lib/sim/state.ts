/**
 * Builds the starting machine state for a scenario: users, services, packages,
 * environment, and the standard directory skeleton for each platform.
 */

import { LINUX_HOME, WINDOWS_HOME, display, parseMode, toKey } from "./paths";
import { makeEntry, seedVfs } from "./vfs";
import type {
  EngineState,
  LocalUser,
  MachineState,
  OfficeDoc,
  OfficeState,
  Platform,
  ScenarioDefinition,
  SeedNode,
  ServiceState,
  Vfs,
} from "./types";

/* -------------------------------------------------------------------------- */
/*  Directory skeletons                                                       */
/* -------------------------------------------------------------------------- */

export const LINUX_TREE: SeedNode[] = [
  { path: "/bin", type: "dir" },
  { path: "/boot", type: "dir" },
  { path: "/dev", type: "dir" },
  { path: "/etc", type: "dir" },
  { path: "/etc/systemd/system", type: "dir" },
  { path: "/etc/systemd/system/multi-user.target.wants", type: "dir" },
  { path: "/home", type: "dir" },
  { path: LINUX_HOME, type: "dir", mode: "755" },
  { path: `${LINUX_HOME}/Desktop`, type: "dir", mode: "755" },
  { path: `${LINUX_HOME}/Documents`, type: "dir", mode: "755" },
  { path: `${LINUX_HOME}/Downloads`, type: "dir", mode: "755" },
  { path: `${LINUX_HOME}/.ssh`, type: "dir", mode: "700" },
  { path: "/opt", type: "dir" },
  { path: "/proc", type: "dir" },
  { path: "/root", type: "dir", mode: "700" },
  { path: "/srv", type: "dir" },
  { path: "/tmp", type: "dir", mode: "1777" },
  { path: "/usr", type: "dir" },
  { path: "/usr/bin", type: "dir" },
  { path: "/usr/local", type: "dir" },
  { path: "/var", type: "dir" },
  { path: "/var/log", type: "dir" },
  { path: "/var/www", type: "dir" },
  { path: "/etc/hostname", content: "server01", mode: "644" },
  { path: "/etc/os-release", mode: "644", content: 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nHOME_URL="https://www.ubuntu.com/"\n' },
  { path: "/etc/hosts", mode: "644", content: "127.0.0.1\tlocalhost\n127.0.1.1\tserver01\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\n" },
  { path: "/etc/passwd", mode: "644", content: "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nstudent:x:1000:1000:Student User:/home/student:/bin/bash\n" },
  { path: "/etc/group", mode: "644", content: "root:x:0:\nsudo:x:27:student\nstudent:x:1000:\n" },
  { path: "/etc/resolv.conf", mode: "644", content: "nameserver 10.10.10.1\nnameserver 1.1.1.1\n" },
  { path: "/etc/fstab", mode: "644", content: "# /etc/fstab: static file system information\nUUID=8f7c2e21-0b3d-4a15-9c8e-77aa12ff3b90 / ext4 defaults 0 1\n" },
  { path: "/var/log/syslog", mode: "640", content: "systemd[1]: Started Daily apt download activities.\n" },
];

/** The profile folders Windows creates for an account. */
function windowsProfile(root: string): SeedNode[] {
  return [
    { path: root, type: "dir" },
    { path: `${root}/Desktop`, type: "dir" },
    { path: `${root}/Documents`, type: "dir" },
    { path: `${root}/Downloads`, type: "dir" },
  ];
}

export const WINDOWS_TREE: SeedNode[] = [
  { path: "/c:", type: "dir" },
  { path: "/c:/Users", type: "dir" },
  ...windowsProfile(WINDOWS_HOME),
  { path: `${WINDOWS_HOME}/Pictures`, type: "dir" },
  { path: "/c:/Program Files", type: "dir" },
  { path: "/c:/Program Files/Common Files", type: "dir" },
  { path: "/c:/ProgramData", type: "dir" },
  { path: "/c:/Windows", type: "dir" },
  { path: "/c:/Windows/System32", type: "dir" },
  { path: "/c:/Windows/System32/drivers", type: "dir" },
  { path: "/c:/Windows/Temp", type: "dir" },
  { path: "/c:/Temp", type: "dir" },
  { path: "/c:/inetpub/wwwroot", type: "dir" },
];

/* -------------------------------------------------------------------------- */
/*  Default users / services                                                  */
/* -------------------------------------------------------------------------- */

function linuxUsers(): LocalUser[] {
  return [
    { name: "root", uid: 0, gid: 0, groups: ["root"], shell: "/bin/bash", home: "/root", passwordHash: "x", locked: false, fullName: "root" },
    { name: "daemon", uid: 1, gid: 1, groups: ["daemon"], shell: "/usr/sbin/nologin", home: "/usr/sbin", passwordHash: "x", locked: true },
    { name: "student", uid: 1000, gid: 1000, groups: ["student", "sudo", "adm"], shell: "/bin/bash", home: LINUX_HOME, passwordHash: "$6$rounds=656000$abc123", locked: false, fullName: "Student User" },
  ];
}

function windowsUsers(hostname: string): LocalUser[] {
  return [
    { name: "Administrator", uid: 500, gid: 544, groups: ["Administrators"], shell: "cmd.exe", home: WINDOWS_HOME, passwordHash: null, locked: false, description: "Built-in account for administering the computer/domain", enabled: true },
    { name: "DefaultAccount", uid: 503, gid: 545, groups: ["Users"], shell: "cmd.exe", home: WINDOWS_HOME, passwordHash: null, locked: true, description: "A user account managed by the system.", enabled: false },
    { name: "student", uid: 1001, gid: 545, groups: ["Users", "Remote Desktop Users"], shell: "cmd.exe", home: WINDOWS_HOME, passwordHash: "u", locked: false, fullName: `student on ${hostname}`, enabled: true },
  ];
}

function linuxServices(): ServiceState[] {
  return [
    { name: "ssh", displayName: "OpenBSD Secure Shell server", active: true, enabled: true, description: "OpenBSD Secure Shell server", unitFile: "/lib/systemd/system/ssh.service" },
    { name: "cron", displayName: "Regular background program processing daemon", active: true, enabled: true, description: "Regular background program processing daemon" },
    { name: "nginx", displayName: "A high performance web server and a reverse proxy server", active: false, enabled: false, description: "nginx web server" },
    { name: "postfix", displayName: "Postfix Mail Transport Agent", active: false, enabled: false, description: "Postfix Mail Transport Agent" },
    { name: "apache2", displayName: "The Apache HTTP Server", active: false, enabled: false, description: "Apache HTTP Server" },
    { name: "ufw", displayName: "Uncomplicated firewall", active: true, enabled: true, description: "Uncomplicated firewall" },
    { name: "smbd", displayName: "Samba SMB Daemon", active: false, enabled: false, description: "Samba SMB Daemon" },
    { name: "firewalld", displayName: "firewalld - dynamic firewall daemon", active: false, enabled: false, description: "firewalld" },
    { name: "networking", displayName: "Networking", active: true, enabled: true, description: "Networking" },
  ];
}

function linuxPackages() {
  return [
    { name: "bash", version: "5.2.21-2ubuntu4", installed: true, description: "GNU Bourne Again SHell" },
    { name: "openssh-server", version: "1:9.6p1-3ubuntu13", installed: true, description: "secure shell (SSH) server" },
    { name: "nginx", version: "1.24.0-2ubuntu7", installed: true, description: "small, powerful, scalable web/proxy server" },
    { name: "postfix", version: "3.8.6-1build1", installed: false, description: "High-performance mail transport agent" },
    { name: "ufw", version: "0.36.2-6", installed: true, description: "program for managing a Netfilter firewall" },
    { name: "curl", version: "8.5.0-2ubuntu10", installed: true, description: "command line tool for transferring data with URL syntax" },
    { name: "vim", version: "2:9.1.0016-1ubuntu7", installed: true, description: "Vi IMproved - enhanced vi editor" },
    { name: "cron", version: "3.0pl1-184ubuntu2", installed: true, description: "process scheduling daemon" },
  ];
}

function linuxProcesses() {
  return [
    { pid: 1, user: "root", cpu: 0.1, mem: 0.3, command: "/sbin/init" },
    { pid: 412, user: "root", cpu: 0.0, mem: 0.2, command: "/lib/systemd/systemd-journald" },
    { pid: 688, user: "root", cpu: 0.0, mem: 0.4, command: "/usr/sbin/sshd -D" },
    { pid: 741, user: "root", cpu: 0.0, mem: 0.1, command: "/usr/sbin/cron -f" },
    { pid: 1204, user: "student", cpu: 0.2, mem: 0.6, command: "-bash" },
  ];
}

function windowsServices(): ServiceState[] {
  return [
    { name: "Spooler", displayName: "Print Spooler", active: true, enabled: true, startupType: "Automatic", description: "Loads files to memory for later printing" },
    { name: "W32Time", displayName: "Windows Time", active: true, enabled: true, startupType: "Manual", description: "Maintains date and time synchronization on all clients and servers" },
    { name: "WinRM", displayName: "Windows Remote Management (WS-Management)", active: false, enabled: false, startupType: "Manual", description: "Windows Remote Management service" },
    { name: "Dnscache", displayName: "DNS Client", active: true, enabled: true, startupType: "Automatic", description: "Caches DNS names" },
    { name: "TermService", displayName: "Remote Desktop Services", active: false, enabled: false, startupType: "Manual", description: "Allows users to connect interactively to a remote computer" },
    { name: "LanmanServer", displayName: "Server", active: true, enabled: true, startupType: "Automatic", description: "Supports file, print, and named-pipe sharing" },
    { name: "WinDefend", displayName: "Microsoft Defender Antivirus Service", active: true, enabled: true, startupType: "Automatic", description: "Helps protect users from malware and other potentially unwanted software" },
    { name: "wuauserv", displayName: "Windows Update", active: true, enabled: true, startupType: "Manual", description: "Enables the detection, download, and installation of updates" },
  ];
}

function windowsProcesses() {
  return [
    { pid: 4, user: "SYSTEM", cpu: 0.0, mem: 0.1, command: "System" },
    { pid: 612, user: "SYSTEM", cpu: 0.1, mem: 0.5, command: "svchost.exe -k DcomLaunch" },
    { pid: 1584, user: "SYSTEM", cpu: 0.2, mem: 0.8, command: "spoolsv.exe" },
    { pid: 3201, user: "student", cpu: 1.4, mem: 1.2, command: "explorer.exe" },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Machine state                                                             */
/* -------------------------------------------------------------------------- */

export function createMachineState(def: ScenarioDefinition): MachineState {
  const platform = def.platform;
  const hostname = def.machine.hostname || (platform === "WINDOWS" ? "WS-01" : "server01");
  // The booted machine must never alias the scenario definition: an attempt that
  // flips a service, edits the registry or deletes an account would otherwise
  // rewrite the definition itself and poison every later attempt (and the
  // validator's dry run). One deep clone per boot keeps the definition pristine.
  const seeded = def.state ? clone(def.state) : undefined;

  if (platform === "WINDOWS") {
    const users = seeded?.users?.length
      ? seeded.users.map((u) => normalizeUser(u, "WINDOWS"))
      : windowsUsers(hostname);
    const services = seeded?.services ?? windowsServices();
    // The signed-in account owns the session: its profile is the working
    // directory and the home reported in the environment. Scenarios that have
    // to change machine-wide settings sign in as `Administrator`, which is what
    // the PowerShell driver's admin check looks for.
    const home = `/c:/Users/${def.machine.user || "student"}`;
    // The built-in user list gives every account the `student` profile, so the
    // account the session runs as has to be corrected to its own — otherwise
    // File Explorer's Home button drops the student into someone else's empty
    // profile instead of the one holding their files.
    const sessionAccount = users.find(
      (user) => user.name.toLowerCase() === (def.machine.user || "student").toLowerCase(),
    );
    if (sessionAccount) sessionAccount.home = home;
    // A scenario that names a domain is joined to Active Directory, so the
    // AD cmdlets and the ADWS service come along with it.
    if (def.machine.domain && !services.some((s) => s.name === "ADWS")) {
      services.push({
        name: "ADWS",
        displayName: "Active Directory Web Services",
        active: true,
        enabled: true,
        startupType: "Automatic",
        description: "Active Directory Web Services",
      });
    }
    return {
      cwd: home,
      env: {
        PATH: "C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\",
        USERPROFILE: display("WINDOWS", home),
        COMPUTERNAME: hostname.toUpperCase(),
        HOMEDRIVE: "C:",
        HOMEPATH: `\\Users\\${def.machine.user || "student"}`,
        TEMP: `${display("WINDOWS", home)}\\AppData\\Local\\Temp`,
        PROCESSOR_ARCHITECTURE: "AMD64",
        PSModulePath: "C:\\Users\\student\\Documents\\WindowsPowerShell\\Modules",
        ...(def.machine.domain ? { DOMAIN: def.machine.domain, USERDNSDOMAIN: `${def.machine.domain}.local` } : {}),
      },
      users,
      services,
      processes: seeded?.processes ?? windowsProcesses(),
      packages: seeded?.packages ?? [],
      cron: seeded?.cron ?? [],
      // Remote Desktop ships enabled — closing it down is a classic hardening
      // task, so the starting state must actually be open.
      firewall: seeded?.firewall ?? [
        { name: "Allow-RDP-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "3389", enabled: true },
        { name: "Allow-HTTP-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "80", enabled: true },
        { name: "Allow-HTTPS-TCP-In", direction: "in", action: "allow", protocol: "tcp", port: "443", enabled: true },
      ],
      registry: seeded?.registry ?? [
        { path: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate", name: "NoAutoUpdate", type: "DWord", value: 0 },
      ],
      shares: seeded?.shares ?? [
        { name: "C$", path: "C:\\", description: "Default share" },
        { name: "IPC$", path: "", description: "Remote IPC" },
      ],
      events: seeded?.events ?? [
        { at: Date.now() - 3_600_000, source: "Service Control Manager", level: "error", id: 7031, message: "The Print Spooler service terminated unexpectedly." },
      ],
      history: [],
      exitCode: 0,
      hostname,
      os: {
        name: def.machine.os || "Microsoft Windows 11 Pro",
        version: def.machine.version || "10.0.22631",
        build: def.machine.build || "22631.3155",
        arch: def.machine.arch || "64-bit",
      },
      notes: [],
      notices: [],
    };
  }

  if (platform === "OFFICE") {
    return {
      cwd: "/Documents",
      env: {},
      users: [],
      services: [],
      processes: [],
      packages: [],
      cron: [],
      firewall: [],
      registry: [],
      shares: [],
      events: [],
      history: [],
      exitCode: 0,
      hostname: hostname || "workstation",
      os: {
        name: def.machine.os || "Office Productivity Suite",
        version: def.machine.version || "2024",
        arch: def.machine.arch || "web",
      },
      notes: [],
      notices: [],
    };
  }

  const users = seeded?.users?.length ? seeded.users.map((u) => normalizeUser(u, "LINUX")) : linuxUsers();
  return {
    cwd: LINUX_HOME,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      EDITOR: "vim",
      DEBIAN_FRONTEND: "noninteractive",
    },
    users,
    services: seeded?.services ?? linuxServices(),
    processes: seeded?.processes ?? linuxProcesses(),
    packages: seeded?.packages ?? linuxPackages(),
    cron: seeded?.cron ?? [],
    // Only the SSH rule exists out of the box; opening a web port is the kind
    // of work a scenario can grade.
    firewall: seeded?.firewall ?? [
      { name: "allow-ssh", direction: "in", action: "allow", protocol: "tcp", port: "22", enabled: true },
    ],
    registry: seeded?.registry ?? [],
    shares: seeded?.shares ?? [],
    events: seeded?.events ?? [
      { at: Date.now() - 5_400_000, source: "sshd", level: "info", id: 0, message: "Server listening on 0.0.0.0 port 22." },
    ],
    history: [],
    exitCode: 0,
    hostname,
    os: {
      name: def.machine.os || "Ubuntu 24.04.2 LTS",
      version: def.machine.version || "24.04",
      kernel: def.machine.kernel || "6.8.0-45-generic",
      arch: def.machine.arch || "x86_64",
    },
    notes: [],
    notices: [],
  };
}

/**
 * Deep-clone plain scenario data. A structured clone where available, and a
 * JSON round trip otherwise — the seeded state is always JSON-shaped.
 */
function clone<T>(value: T): T {
  return typeof structuredClone === "function" ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

function normalizeUser(input: Partial<LocalUser> & { name: string }, platform: Platform): LocalUser {
  const isWin = platform === "WINDOWS";
  return {
    name: input.name,
    uid: input.uid ?? 1000,
    gid: input.gid ?? 1000,
    groups: input.groups ?? (isWin ? ["Users"] : [input.name]),
    shell: input.shell ?? (isWin ? "cmd.exe" : "/bin/bash"),
    home: input.home ?? (isWin ? `/c:/users/${input.name}` : `/home/${input.name}`),
    fullName: input.fullName,
    description: input.description,
    passwordHash: input.passwordHash ?? (isWin ? null : "x"),
    locked: input.locked ?? false,
    enabled: input.enabled ?? true,
  };
}

/* -------------------------------------------------------------------------- */
/*  Office state                                                              */
/* -------------------------------------------------------------------------- */

export function createOfficeState(def: ScenarioDefinition): OfficeState {
  // Clone for the same reason as the machine state: documents are edited in
  // place, and the definition must survive the attempt untouched.
  const seededDocs = def.docs ? clone(def.docs) : [];
  const docs: Record<string, OfficeDoc> = {};
  for (const doc of seededDocs) docs[doc.name] = doc;
  return {
    docs,
    activeDoc: seededDocs[0]?.name,
    user: {
      name: def.machine.user || "student",
      email: `${def.machine.user || "student"}@ontrak.local`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Full initial state                                                        */
/* -------------------------------------------------------------------------- */

export function createInitialState(def: ScenarioDefinition): EngineState {
  const platform = def.platform;
  const base: Vfs = {};
  const rootPath = platform === "WINDOWS" ? "/c:" : "/";
  base[toKey(platform, rootPath)] = makeEntry(rootPath, { type: "dir" });

  const skeleton = platform === "WINDOWS" ? WINDOWS_TREE : platform === "LINUX" ? LINUX_TREE : [];
  let vfs = seedVfs(platform, skeleton, base);

  // `/etc/hostname` and friends should reflect the scenario's real hostname.
  if (platform === "LINUX") {
    vfs = seedVfs(platform, [{ path: "/etc/hostname", content: `${def.machine.hostname}\n` }], vfs);
  }

  const machine = createMachineState(def);
  if (platform === "WINDOWS") {
    // Whoever the scenario signs in as gets a working profile — the shipped
    // tree only contains the default `student` one.
    vfs = seedVfs(platform, windowsProfile(machine.cwd), vfs);
  }
  if (platform === "LINUX") {
    vfs[toKey(platform, "/etc/passwd")] = makeEntry("/etc/passwd", {
      content: `${machine.users
        .map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.fullName ?? u.name}:${u.home}:${u.shell}`)
        .join("\n")}\n`,
      mode: parseMode("644"),
      owner: "root",
      group: "root",
    });
  }

  vfs = seedVfs(platform, def.files, vfs);

  return {
    vfs,
    machine,
    office: createOfficeState(def),
    meta: { hintsUsed: [], revision: 0 },
  };
}
