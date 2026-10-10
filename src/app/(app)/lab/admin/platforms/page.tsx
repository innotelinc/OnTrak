import type { Metadata } from "next";

import { requireLabStaff } from "@/lib/lab-admin-access";
import { guardedRead, platformGroups, readyPool, readyTemplates } from "@/lib/lab/admin";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Alert, Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";

export const metadata: Metadata = { title: "Lab — platforms" };

/**
 * The catalogue, the images the host holds, and the templates built from them.
 *
 * Three questions an operator asks before a class, answered together because they are the same
 * question at three stages: *can this platform be built* (the catalogue entry and the plan),
 * *is its image here* (the host's aliases), and *is a template already standing* (the warm
 * pool and the template list). `admin.py`'s `/admin/platforms` is the same page, and the rule
 * it carried is kept: every reading that shells out to `incus` is guarded, so a host that has
 * not been prepared renders with a line saying so rather than a 500 — which is exactly the
 * host this page is most likely to be opened on.
 *
 * The plan is shown per entry rather than as a reachability list, because a platform this
 * deployment *cannot* build is the interesting row: it names the command that would publish
 * its image, which is what turns "why is Windows 95 greyed out" into an answer.
 */
export default async function LabAdminPlatformsPage() {
  await requireLabStaff();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="platforms"
      title="Platforms"
      description="Every workload the catalogue offers, and what this host can stand up from it."
    >
      {runtime === null ? <LabOff reason={reason} /> : <Platforms runtime={runtime} />}
    </LabAdminPanel>
  );
}

async function Platforms({ runtime }: { runtime: LabRuntime }) {
  const problems: string[] = [];
  const aliases = await guardedRead("Incus images", () => runtime.manager.imageAliases(), problems);
  const templates = await guardedRead("templates", () => runtime.manager.templateStatus(), problems);
  const pool = await guardedRead("warm pool", () => runtime.manager.poolStatus(), problems);

  const groups = platformGroups(runtime.catalog, aliases);
  const catalogueProblems = runtime.catalog.validate();
  const entries = groups.reduce((total, group) => total + group.entries.length, 0);
  const provisionable = groups.reduce(
    (total, group) => total + group.entries.filter((entry) => entry.plan?.ready).length,
    0,
  );
  const imageAliases = new Set(aliases);

  return (
    <>
      {problems.length > 0 ? (
        <Alert tone="amber" title="The host did not answer every question">
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Catalogue entries" value={String(entries)} />
        <Stat label="Provisionable here" value={`${provisionable} / ${entries}`} tone="teal" />
        <Stat label="Images on the host" value={String(aliases.length)} />
        <Stat label="Templates built" value={`${readyTemplates(templates)} / ${templates.length}`} />
      </div>

      {catalogueProblems.length > 0 ? (
        <Alert tone="pink" title="The catalogue does not validate">
          <ul className="space-y-1">
            {catalogueProblems.slice(0, 10).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading
          title="Warm now"
          description="Handout-ready machines per scenario, and the target each window aims at."
        />
        {pool.length === 0 ? (
          <EmptyState title="The pool is empty" description="Nothing is prewarmed on this host." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The warm pool, per scenario</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Scenario</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Platform</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Ready</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">In use</th>
                  <th scope="col" className="py-2 font-semibold">Template</th>
                </tr>
              </thead>
              <tbody>
                {pool.map((status) => (
                  <tr key={status.label} className="border-t border-line">
                    <td className="py-2 pr-4 font-mono text-xs text-ink-soft">{status.scenarioId}</td>
                    <td className="py-2 pr-4 text-xs text-ink-faint">{status.workload || "default"}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {status.ready} / {status.target}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-faint">{status.claimed}</td>
                    <td className="py-2">
                      {status.templateReady ? (
                        <Badge tone="teal">built</Badge>
                      ) : (
                        <Badge tone="neutral">not built</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-ink-faint">
          {readyPool(pool)} machine{readyPool(pool) === 1 ? "" : "s"} ready across{" "}
          {pool.length} scenario{pool.length === 1 ? "" : "s"}.
        </p>
      </Card>

      {groups.map((group) => (
        <Card key={group.group.id} className="space-y-3">
          <SectionHeading
            title={group.group.label}
            description={`${group.group.description}${group.group.era ? ` · ${group.group.era}` : ""}`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{group.group.label} entries</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Entry</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Edition</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Media</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Image</th>
                  <th scope="col" className="py-2 font-semibold">How it is built</th>
                </tr>
              </thead>
              <tbody>
                {group.entries.map(({ entry, plan }) => (
                  <tr key={entry.id} className="border-t border-line align-top">
                    <td className="py-2 pr-4">
                      <span className="font-semibold text-ink">{entry.name}</span>
                      <span className="block font-mono text-xs text-ink-faint">{entry.id}</span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">
                      {entry.edition || "—"}
                      {entry.released ? (
                        <span className="block text-ink-faint">released {entry.released}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">
                      {entry.media.isImage ? "image alias" : entry.media.kind}
                      <span className="block text-ink-faint">
                        {entry.media.isFree ? "free media" : "operator-supplied"}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      {entry.media.isImage ? (
                        imageAliases.has(entry.imageAlias) ? (
                          <Badge tone="teal">present</Badge>
                        ) : (
                          <Badge tone="amber">missing</Badge>
                        )
                      ) : (
                        <span className="text-xs text-ink-faint">built from a file</span>
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {plan === null ? (
                        <span className="text-pink">the plan could not be worked out</span>
                      ) : (
                        <>
                          <span className={plan.ready ? "text-ink-soft" : "text-amber"}>
                            {plan.label}
                          </span>
                          {plan.estimateSeconds > 0 ? (
                            <span className="block text-ink-faint">
                              about {Math.round(plan.estimateSeconds / 60)} min
                            </span>
                          ) : null}
                          {plan.blockers.length > 0 ? (
                            <span className="block text-amber">{plan.blockers[0]}</span>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}
