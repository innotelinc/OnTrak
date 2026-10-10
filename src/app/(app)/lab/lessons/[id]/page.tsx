import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { PageHeader } from "@/components/PageHeader";
import { LabOff } from "@/components/lab/LabAdminPanel";
import { Badge, Card, EmptyState, SectionHeading } from "@/components/ui";

export const metadata: Metadata = { title: "OnTrak Lab — lesson" };

/**
 * One walkthrough, in full.
 *
 * This is `app.py`'s `/lessons/{id}`, and the two links it drew are the useful part: **which
 * scenarios this lesson is the walkthrough for** (the other direction of the link, so a
 * student can go from learning to doing) and **what it assumes you already know**
 * (`forScenario` over the lesson's own `prerequisites`). Both are relationships the data
 * already carries, so the page invents no ordering of its own.
 *
 * An unknown id is a 404 rather than a redirect-with-a-message: the Python bounced to the
 * index, but a lesson URL is something a student bookmarks and an instructor pastes into a
 * ticket, and quietly answering a different page for a mistyped id is how a link that no
 * longer exists keeps looking like one that does.
 */
export default async function LabLessonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const { runtime, reason } = await labRuntimeForPage();

  if (runtime === null) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader eyebrow="OnTrak Lab" title="Lesson" />
        <LabOff reason={reason} />
      </div>
    );
  }

  return <Lesson runtime={runtime} id={decodeURIComponent(id)} />;
}

function Lesson({ runtime, id }: { runtime: LabRuntime; id: string }) {
  const lesson = runtime.lessons.find(id);
  if (lesson === null) notFound();

  const prerequisites = runtime.lessons.forScenario(lesson.prerequisites);
  const related = runtime.repository.list().filter((scenario) => scenario.lessons.includes(lesson.id));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="OnTrak Lab · Lesson"
        title={lesson.title}
        description={lesson.summary}
        actions={
          <Link href="/lab/lessons" className="text-sm font-semibold text-brand hover:underline">
            ← All lessons
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="neutral">{lesson.platform}</Badge>
        <Badge tone="neutral">{lesson.category}</Badge>
        <span className="text-ink-faint">level {lesson.difficulty}</span>
        <span className="text-ink-faint">· about {lesson.minutes} minutes</span>
        {lesson.docs.length > 0 ? (
          <span className="font-mono text-ink-faint">· {lesson.docs.join(", ")}</span>
        ) : null}
      </div>

      {prerequisites.length > 0 ? (
        <Card className="space-y-2">
          <SectionHeading title="Before this one" description="The lesson assumes you can already do:" />
          <ul className="flex flex-wrap gap-2 text-xs">
            {prerequisites.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/lab/lessons/${encodeURIComponent(entry.id)}`}
                  className="font-semibold text-brand hover:underline"
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {lesson.objectives.length > 0 ? (
        <Card className="space-y-2">
          <SectionHeading title="What you will be able to do" />
          <ul className="list-inside list-disc space-y-1 text-sm text-ink-soft">
            {lesson.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {lesson.steps.length > 0 ? (
        <Card className="space-y-4">
          <SectionHeading title="The walkthrough" />
          <ol className="space-y-4">
            {lesson.steps.map((step, index) => (
              <li key={`${step.title}-${index}`} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <p className="text-sm font-semibold text-ink">
                  {index + 1}. {step.title}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{step.body}</p>
                {step.command !== "" ? (
                  <pre className="mt-2 overflow-x-auto rounded-xl2 border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-soft">
                    {step.command}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {lesson.commands.length > 0 ? (
        <Card className="space-y-3">
          <SectionHeading title="Commands worth knowing" description="What each one does, and where it bites." />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The commands this lesson teaches</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Command</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">What it does</th>
                  <th scope="col" className="py-2 font-semibold">Example</th>
                </tr>
              </thead>
              <tbody>
                {lesson.commands.map((entry, index) => (
                  <tr key={`${entry.command}-${index}`} className="border-t border-line align-top">
                    <td className="py-2 pr-4 font-mono text-xs text-ink">
                      {entry.command}
                      {entry.danger !== "" ? (
                        <span className="mt-1 block">
                          <Badge tone="pink">careful</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">
                      {entry.what}
                      {entry.danger !== "" ? (
                        <span className="mt-1 block text-pink">{entry.danger}</span>
                      ) : null}
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-faint">{entry.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {lesson.exercises.length > 0 ? (
        <Card className="space-y-3">
          <SectionHeading title="Try it" description="Practice tasks, with a way to check yourself." />
          <ul className="space-y-4">
            {lesson.exercises.map((exercise) => (
              <li key={exercise.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <p className="text-sm font-semibold text-ink">{exercise.prompt}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  <span className="font-semibold text-ink-soft">One answer:</span> {exercise.solution}
                </p>
                {exercise.verify !== "" ? (
                  <pre className="mt-2 overflow-x-auto rounded-xl2 border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-soft">
                    {exercise.verify}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading
          title="Where this is used"
          description="The scenarios that send a student back to this lesson."
        />
        {related.length === 0 ? (
          <EmptyState
            title="No scenario links here yet"
            description="This lesson stands on its own for now."
          />
        ) : (
          <ul className="space-y-1 text-sm">
            {related.map((scenario) => (
              <li key={scenario.id} className="flex items-baseline gap-2">
                <Link href="/lab" className="font-semibold text-brand hover:underline">
                  {scenario.title}
                </Link>
                <span className="font-mono text-xs text-ink-faint">{scenario.id}</span>
                <span className="text-xs text-ink-faint">· {scenario.categoryLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
