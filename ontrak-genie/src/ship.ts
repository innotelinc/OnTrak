/**
 * Shipping a terminal session: save the work as a project, commit it, push it.
 *
 * The console's publish flow starts from a project that already exists — it has a
 * folder picker and a project list, so the noun comes first. A terminal does not:
 * a person typed a request, the agent wrote files, and the only thing they have is
 * a workspace. So this is the missing first step and the whole of the button:
 *
 *   1. **Adopt** the workspace as a project (`adoptProject`). A directory that is
 *      already a project is reused under its own name, which is what makes a
 *      second press of ship after more edits a push rather than a name clash.
 *   2. **Publish** it through the same `publishProject` the console uses — create
 *      the repository, point `origin`, commit, push. Nothing here re-implements
 *      git; it would only be a second, weaker copy of that module's fences.
 *
 * A failure after step 1 is not a failure of the whole thing, and the error says
 * which part survived: the project *is* on disk, and its name is in the message so
 * the person can find the work they were just told about.
 */

import { config } from "./config.js";
import {
  adoptProject,
  ProjectError,
  type AdoptedProject,
} from "./projects.js";
import { publishProject, RemoteError, type PublishProjectResult } from "./remote.js";
import { slugify } from "./repo-rules.js";

/** A ship that did not finish, carrying the project it did manage to save. */
export class ShipError extends Error {
  readonly project: AdoptedProject | null;

  constructor(message: string, project: AdoptedProject | null = null) {
    super(message);
    this.name = "ShipError";
    this.project = project;
  }
}

export interface ShipInput {
  /** The project's name. May be omitted when the directory already is one. */
  name?: unknown;
  description?: unknown;
  /** Sandbox-relative directory; defaults to the account's chosen workspace. */
  dir?: unknown;
  /** `atlas` (the deployment's forge) or `github`. Defaults to whichever is configured. */
  target?: unknown;
  /** The commit message. */
  message?: unknown;
  private?: unknown;
  /** A GitHub token, when the target is GitHub. */
  token?: unknown;
}

export interface ShipResult {
  project: AdoptedProject;
  publish: PublishProjectResult;
}

/**
 * Where a project goes when nobody said.
 *
 * Atlas is the estate's own forge and the deployment already holds a credential
 * for it, so it is the target that works without asking a person for a secret
 * mid-sentence. GitHub is the fallback for a deployment with no Atlas — and the
 * one that needs a token, which the console asks for and this module passes
 * through.
 */
export function defaultShipTarget(): "atlas" | "github" {
  return config.atlasUrl !== "" ? "atlas" : "github";
}

function normalizeTarget(raw: unknown): string {
  const target = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (target === "") return defaultShipTarget();
  if (target === "atlas" || target === "forge" || target === "gitea" || target === "github") return target;
  throw new ShipError('a target of "atlas" or "github" is required');
}

/**
 * Save the workspace as a project and push it to a repository.
 *
 * The project is adopted with `open: true`: after a ship, the terminal's next
 * turn works in the directory that was just saved, so the thing a person pushed
 * and the thing the agent keeps editing are the same files.
 */
export async function shipProject(input: ShipInput = {}): Promise<ShipResult> {
  const target = normalizeTarget(input.target);

  let project: AdoptedProject;
  try {
    project = await adoptProject({
      name: input.name,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.dir === undefined ? {} : { dir: input.dir }),
      open: true,
    });
  } catch (error) {
    if (error instanceof ProjectError) throw new ShipError(error.message);
    throw error;
  }

  // The repository is named for the project, not for its directory. A project
  // directory carries a digest so two names that slug the same still get separate
  // folders (`projectDirName`); a repository does not need that, and
  // `ship-check-d24453` is a name a person did not choose.
  const repoName = slugify(project.name);

  try {
    const publish = await publishProject({
      target,
      dir: project.dir,
      ...(repoName === "" ? {} : { name: repoName }),
      ...(typeof input.message === "string" && input.message.trim() !== ""
        ? { message: input.message }
        : {}),
      ...(input.private === undefined ? {} : { private: input.private }),
      ...(typeof input.token === "string" && input.token.trim() !== "" ? { token: input.token } : {}),
    });
    return { project, publish };
  } catch (error) {
    if (error instanceof RemoteError) {
      throw new ShipError(
        `saved “${project.name}” as a project, but the push failed: ${error.message}`,
        project,
      );
    }
    throw error;
  }
}
