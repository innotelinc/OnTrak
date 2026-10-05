/**
 * Prisma adapter for the per-tenant assist opt-in (M7).
 *
 * The setting lives on the tenant row rather than in a table of its own: it is one
 * boolean, there is exactly one per tenant, and a separate row would only add a join
 * to a question asked on every ticket page. The client is described structurally,
 * like every other Prisma surface in this project, so the service layer never depends
 * on a generated type.
 */

import type { AssistSettingsStore } from "./assist-settings-service";

export interface AssistSettingsPrismaClient {
  tenant: {
    findUnique(args: unknown): Promise<{ assistEnabled: boolean } | null>;
    update(args: unknown): Promise<unknown>;
  };
}

export class PrismaAssistSettingsStore implements AssistSettingsStore {
  constructor(private readonly db: AssistSettingsPrismaClient) {}

  async get(tenantId: string): Promise<boolean> {
    const row = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { assistEnabled: true },
    });
    return row?.assistEnabled ?? false;
  }

  async set(tenantId: string, enabled: boolean): Promise<void> {
    await this.db.tenant.update({ where: { id: tenantId }, data: { assistEnabled: enabled } });
  }
}
