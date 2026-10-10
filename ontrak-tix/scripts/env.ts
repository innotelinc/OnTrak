/**
 * Load `.env` for a script run from a terminal.
 *
 * `next dev`, the Prisma CLI and (as a side effect of the client it builds)
 * Prisma Client each read `.env` themselves, which is why a script here often
 * works without saying anything about it. Reading it here makes the load
 * *ordered and visible* instead: this module is imported first, so the variables
 * exist before any part of the app is evaluated, and a script that needs this to
 * be true does not have to rely on somebody else's side effect. Existing
 * variables always win — a value exported for this run (`DATABASE_URL` pointed
 * at a rehearsal database, say) is a deliberate override, not an accident to be
 * corrected.
 *
 * Import this module *before* anything that builds a Prisma client: import
 * order is evaluation order, so a side-effect import first is what lets the app
 * be imported statically further down the file.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadEnv(files: readonly string[] = [".env.local", ".env"]): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}

loadEnv();
