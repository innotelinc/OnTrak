/**
 * OnTrak Sentinel S4 tests: the mute at the surface a person reaches.
 *
 * The rules and the pipeline were tested without a socket (`sentinel-alert-suppression.test.ts`);
 * this is the queue page — who may see the windows, who may set one, and what the page says when
 * there are none. The cases are the two ways a mute surface goes wrong:
 *
 *  - **It is a page for everybody.** A list of what is silenced names where the detector has been
 *    made blind, so the section is rendered only for an administrator — and the *service* refuses
 *    the write regardless, because the nav hiding a link is not an access control.
 *  - **A mute that names nothing is accepted.** "Silence everything" is the one rule a person
 *    makes by accident, so it is refused by the service with the sentence saying so, and the page
 *    only reports it.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { ASSIGNEE_ANY, type TriageFilter } from "../src/lib/alert-triage-rules";
import {
  MemorySuppressionStore,
  SuppressionService,
} from "../src/lib/alert-suppression-service";
import { ConsoleService } from "../src/lib/console-service";
import { renderAlerts } from "../src/lib/console-rules";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";

const sha256: HashFn = sha256Hex;

const FILTER: TriageFilter = {
  state: "OPEN",
  severity: "ALL",
  assignee: ASSIGNEE_ANY,
  identityId: null,
  address: null,
  search: "",
};

/**
 * A `datetime-local` value, which is what the form submits. The window is relative to the real
 * clock on purpose: this page decides `active` against `Date.now()`, so a hard-coded window would
 * be in the future (or the past) depending on when the suite runs.
 */
function localDateTime(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A window's worth of form fields, with the parts a case does not care about left blank. */
const draft = (over: Partial<Record<"name" | "ruleIds" | "sourceAddresses" | "startsAt" | "endsAt", string>> = {}) => ({
  name: "February patch window",
  ruleIds: "SG-BEH-002",
  sourceAddresses: "",
  assets: "",
  devices: "",
  identityIds: "",
  startsAt: localDateTime(Date.now() - 3_600_000),
  endsAt: localDateTime(Date.now() + 3_600_000),
  ...over,
});

let seq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const tag = `sc${++seq}`;
  const clock = Date.parse("2026-11-01T09:00:00.000Z");
  let n = 0;
  const ids = {
    id: () => `${tag}-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };

  const spine = new IdentityService(identities, audit, ids);
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit, {
    id: () => `${tag}-m${++n}`,
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const detection = new DetectionService(new MemoryAlertStore(), identities, audit);
  const suppressions = new SuppressionService(new MemorySuppressionStore(), audit, ids);
  // Positional, like the deployment's wiring: detection is the tenth collaborator and the mute
  // is the last, and everything between them is a console feature this suite does not exercise.
  const service = new ConsoleService(
    spine,
    mfa,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    detection,
    null,
    null,
    null,
    suppressions,
  );

  async function sessionFor(actor: IdentityActor, identityId: string) {
    const enrolled = await spine.setMfaEnrolled(actor, identityId, true);
    assert.ok(enrolled.ok, enrolled.ok ? "" : enrolled.error);
    const session = await spine.issueSession(actor.organizationId, identityId);
    assert.ok(session.ok, session.ok ? "" : session.error);
    return session.value.id;
  }

  return {
    service,
    suppressions,
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, {
        identifier: `admin@${slug}.test`,
        displayName: `Admin ${slug}`,
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN",
      };
      return { actor, sessionId: await sessionFor(actor, actor.id) };
    },
    async member(actor: IdentityActor, organizationId: string, slug: string) {
      const created = await spine.createIdentity(actor, {
        identifier: `member@${slug}.test`,
        displayName: `Member ${slug}`,
        role: "AGENT",
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const member: IdentityActor = { id: created.value.id, organizationId, role: "AGENT" };
      return { actor: member, sessionId: await sessionFor(member, created.value.id) };
    },
  };
}

test("the queue carries the windows, and only an administrator may see or set one", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  // Nothing is silenced to begin with, and the section is there for an administrator.
  const before = await h.service.alerts(sessionId, FILTER, null);
  assert.ok(before.ok, before.ok ? "" : before.error);
  if (!before.ok) return;
  assert.equal(before.value.canSuppress, true);
  assert.deepEqual(before.value.suppressions, []);
  assert.match(renderAlerts(before.value), /Nothing is silenced/);

  const added = await h.service.addSuppression(sessionId, draft());
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.value.name, "February patch window");

  const after = await h.service.alerts(sessionId, FILTER, null);
  assert.ok(after.ok, after.ok ? "" : after.error);
  if (!after.ok) return;
  assert.equal(after.value.suppressions.length, 1);
  const window = after.value.suppressions[0]!;
  assert.equal(window.matcherLabel, "rule SG-BEH-002");
  assert.equal(window.active, true);
  assert.equal(window.createdByLabel, "Admin acme");
  const html = renderAlerts(after.value);
  assert.match(html, /Silenced windows \(1 in force\)/);
  assert.match(html, /February patch window/);

  // A member cannot see the section, and the service refuses the write too — the page hiding a
  // link is not an access control.
  const member = await h.member(actor, actor.organizationId, "acme");
  const memberView = await h.service.alerts(member.sessionId, FILTER, null);
  assert.ok(memberView.ok, memberView.ok ? "" : memberView.error);
  if (!memberView.ok) return;
  assert.equal(memberView.value.canSuppress, false);
  assert.deepEqual(memberView.value.suppressions, []);
  assert.doesNotMatch(renderAlerts(memberView.value), /Silenced windows/);

  const refused = await h.service.addSuppression(member.sessionId, draft({ name: "sneaky" }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /administrator/);

  // A mute that names nothing would silence every detection, so it is refused by name.
  const empty = await h.service.addSuppression(
    sessionId,
    draft({ name: "everything", ruleIds: "", sourceAddresses: "" }),
  );
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /name something/);

  // And it can be taken back out, leaving the chain the record that it existed.
  const removed = await h.service.removeSuppression(sessionId, window.id);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.value.name, "February patch window");
  assert.deepEqual(await h.suppressions.list(actor.organizationId), []);

  const cleared = await h.service.alerts(sessionId, FILTER, null);
  assert.ok(cleared.ok, cleared.ok ? "" : cleared.error);
  if (!cleared.ok) return;
  assert.deepEqual(cleared.value.suppressions, []);
});
