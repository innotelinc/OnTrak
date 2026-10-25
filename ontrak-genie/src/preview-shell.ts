/**
 * How a preview command is handed to a shell.
 *
 * Both preview modules (the registry's runner and the older one) used to spawn
 * `bash -lc <command>`. That is correct in the Linux container and wrong on a
 * Windows host, where `bash` may not exist at all: the spawn emits `error`,
 * never listens, and every preview address times out while the console reports
 * only "backend not answering yet".
 *
 * The command is already a single string, so the fallback is Node's own shell
 * mode (`shell: true`), which builds the Windows command line correctly.
 * `cmd.exe /d /s /c <argv>` is deliberately not used: it re-quotes the command
 * and destroys the inner quotes of something like `node -e "..."`.
 */

import { existsSync } from "node:fs";

export interface ShellSpec {
  file: string;
  args: string[];
  shell: boolean;
}

const BASH_CANDIDATES = [
  "/usr/bin/bash",
  "/bin/bash",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

export function previewShell(command: string, platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform !== "win32") return { file: "bash", args: ["-lc", command], shell: false };

  for (const candidate of BASH_CANDIDATES) {
    if (existsSync(candidate)) return { file: candidate, args: ["-lc", command], shell: false };
  }

  return { file: command, args: [], shell: true };
}
