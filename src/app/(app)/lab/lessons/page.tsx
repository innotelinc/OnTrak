import Link from "next/link";
import type { Metadata } from "next";

import { requireSession } from "@/lib/auth";
import { lessonIndex } from "@/lib/lab/portal";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { PageHeader } from "@/components/PageHeader";
import { LabOff } from "@/components/lab/LabAdminPanel";
import { Alert, Badge, Card, EmptyState, SectionHeading } from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "OnTrak Lab — lessons" };

/**
 * The walkthrough library.
 *
 * This is `app.py`'s `/lessons`, and the reason it exists is worth keeping from the Python's
 * own docstring: the moment a student wants to know how `chmod` works is the moment they are
 * staring at a broken machine, not before — so the library is reachable from the dashboard
 * and from a session rather than only from a course page, and it is open to students and
 * instructors alike (`requireSession`, not a staff gate).
 *
 * Grouping and labels come from the repository (`byPlatform`) and the summary rows from
 * `portal.ts`'s `lessonIndex` — the same read model the CLI lists with — so a lesson cannot
 * be described one way here and another way there.
 */
export default async function LabLessonsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  await requireSession();
  const { platform } = await searchParams;
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="OnTrak Lab"
        title="Lessons"
        description="Short walkthroughs for the faults the range throws at you — read them before or mid-session."
        actions={
          <Link href="/lab" className="text-sm font-semibold text-brand hover:underline">
            ← My machines
          </Link>
        }
      />
      {runtime === null ? <LabOff reason={reason} /> : <Library runtime={runtime} selected={platform ?? ""} />}
    </div>
  );
}

async function Library({ runtime, selected }: { runtime: LabRuntime; selected: string }) {
  const grouped = runtime.lessons.byPlatform();
  const platforms = [...grouped.keys()].sort();
  const chosen = platforms.includes(selected) ? selected : "";
  const problems = runtime.lessons.validate();

  const visible = chosen === "" ? platforms : platforms.filter((platform) => platform === chosen);

  return (
    <>
      {problems.length > 0 ? (
        <Alert tone="amber" title="The lesson library has problems">
          <ul className="space-y-1">
            {problems.slice(0, 10).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <nav aria-label="Filter lessons by platform" className="flex flex-wrap gap-2">
        <Link
          href="/lab/lessons"
          aria-current={chosen === "" ? "page" : undefined}
          className={cn(
            "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition",
            chosen === ""
              ? "border-brand/40 bg-brand/12 text-brand"
              : "border-line text-ink-soft hover:border-brand/30 hover:text-brand",
          )}
        >
          Every platform
        </Link>
        {platforms.map((platform) => (
          <Link
            key={platform}
            href={`/lab/lessons?platform=${encodeURIComponent(platform)}`}
            aria-current={chosen === platform ? "page" : undefined}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-xs font-semibold capitalize transition",
              chosen === platform
                ? "border-brand/40 bg-brand/12 text-brand"
                : "border-line text-ink-soft hover:border-brand/30 hover:text-brand",
            )}
          >
            {platform}
          </Link>
        ))}
      </nav>

      {runtime.lessons.list().length === 0 ? (
        <EmptyState title="No lessons shipped" description="The lesson library is empty on this deployment." />
      ) : (
        visible.map((platform) => {
          const lessons = lessonIndex(runtime.lessons, platform);
          return (
            <Card key={platform} className="space-y-3">
              <SectionHeading
                title={platform}
                description={`${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`}
              />
              <ul className="space-y-3">
                {lessons.map((lesson) => (
                  <li key={lesson.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        href={`/lab/lessons/${encodeURIComponent(lesson.id)}`}
                        className="font-semibold text-brand hover:underline"
                      >
                        {lesson.title}
                      </Link>
                      <span className="flex items-center gap-2 text-xs text-ink-faint">
                        <Badge tone="neutral">{lesson.category}</Badge>
                        <span>level {lesson.difficulty}</span>
                        <span>· {lesson.minutes} min</span>
                        <span>
                          · {lesson.commands} command{lesson.commands === 1 ? "" : "s"}
                        </span>
                        <span>
                          · {lesson.exercises} exercise{lesson.exercises === 1 ? "" : "s"}
                        </span>
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-soft">{lesson.summary}</p>
                    {lesson.tags.length > 0 ? (
                      <p className="mt-1 font-mono text-xs text-ink-faint">{lesson.tags.join(" · ")}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}
    </>
  );
}
