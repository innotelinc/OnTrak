import "server-only";

import type { Platform } from "@prisma/client";
import { prisma } from "./db";
import { evaluatePackage } from "./availability-rules";
import { sandboxAvailability, sandboxConfigFromEnv } from "./sim/fidelity";

/**
 * Availability — the queries that feed the rule.
 *
 * The rule itself lives in `availability-rules.ts` as pure functions so it can
 * be shared by the client, the server and the test suite. This module only
 * loads the data the rule needs; because availability is *derived* rather than
 * stored, an admin flipping a toggle immediately changes what students see,
 * with no cache to invalidate.
 */

// The rule itself is re-exported so every existing `@/lib/availability`
// import keeps working while the implementation stays unit-testable.
export * from "./availability-rules";

export async function loadAvailabilityContext() {
  const toggles = await prisma.platformToggle.findMany();
  const disabled = new Set<Platform>();
  const enabledNames = new Set(toggles.filter((toggle) => toggle.enabled).map((toggle) => toggle.platform));
  // A platform with no row yet counts as enabled (fresh install convenience).
  for (const platform of ["LINUX", "WINDOWS", "OFFICE"] as Platform[]) {
    if (toggles.some((toggle) => toggle.platform === platform) && !enabledNames.has(platform)) {
      disabled.add(platform);
    }
  }
  // The sandbox is configuration, not data: it comes from the environment on every read so
  // starting a container (or taking one away) changes the catalogue immediately, exactly
  // like a platform toggle.
  return { disabledPlatforms: disabled, sandbox: sandboxAvailability(sandboxConfigFromEnv(process.env)) };
}

/** Reason list rendered on the admin dashboard. */
export async function inventoryHealth() {
  const packages = await prisma.softwarePackage.findMany({
    include: { _count: { select: { scenarios: true } } },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
  });
  return packages.map((pkg) => ({
    pkg,
    blockers: evaluatePackage(pkg),
    usedBy: pkg._count.scenarios,
  }));
}

/** Load scenarios with everything availability needs, in one round trip. */
export async function loadScenariosWithSoftware(where?: { platform?: Platform; published?: boolean; authorId?: string }) {
  return prisma.scenario.findMany({
    where,
    include: {
      software: { include: { softwarePackage: true } },
      author: { select: { id: true, name: true } },
      _count: { select: { attempts: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
}
